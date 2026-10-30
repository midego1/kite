"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import {
	MIGRATION_POLL_MS,
	MIGRATION_RECOVERY_CAP_MS,
	MIGRATION_RUN_FLAG,
	MIGRATION_RUN_LOCK,
	MIGRATION_STALL_MS,
	createStallTracker,
	isRunFlagActive,
	isTransientStatus,
	mergeRemaining,
	shouldAbortPost,
	startStatusPolling,
} from "./migration-poll-utils";
import {
	MIGRATION_OUTCOME_UNKNOWN,
	migrationApplyFailure,
	migrationDoneSummary,
	migrationRecoveredSummary,
} from "./migration-progress-utils";
import type { MigrationApplyResponse } from "./migrations-banner-types";

const STATUS_API = "/api/admin/migrations";
const POLL_TIMEOUT_MS = 15_000;

/** Which surface started the run; only that one shows the steps and the result, the others just show a busy button. */
export type MigrationApplySource = "admin" | "mailbox";

export interface MigrationApplyState {
	/** Whether the update button must be busy: this tab runs an update, or another tab says it does. */
	applying: boolean;
	/** This tab holds the request open. */
	running: boolean;
	/** Another tab is applying updates (it holds the run lock, or keeps a flag in localStorage fresh without locks). */
	remote: boolean;
	/** The connection dropped while the server may still be migrating; the pending list is being watched. */
	recovering: boolean;
	source: MigrationApplySource | null;
	/** The pending migrations when the run started, and the ones still pending at the last poll. */
	startNames: string[];
	remaining: string[] | null;
	startedAt: number | null;
	summary: string | null;
	error: string | null;
	/** Counts runs that ended in another tab, so this tab reads the pending list again. */
	refreshTick: number;
}

/** The POST's answer: the migration status plus what was applied. */
export type MigrationApplyResult = MigrationApplyResponse & { ready?: boolean; pending?: string[]; unknown?: string[] };

export type MigrationApplyOutcome =
	{ ok: true; result: MigrationApplyResult; summary: string } | { ok: false; error: string };

const IDLE: MigrationApplyState = {
	applying: false,
	running: false,
	remote: false,
	recovering: false,
	source: null,
	startNames: [],
	remaining: null,
	startedAt: null,
	summary: null,
	error: null,
	refreshTick: 0,
};

// The admin card, the reading-pane card and the banner show the same run, and the reader can move between
// them mid-apply, so the state lives outside every component.
let state: MigrationApplyState = IDLE;
let runId = 0;
// A run whose session ended: it finishes, but its summary or error belongs to the previous session.
let discardedRun = -1;
// Between the click and the answer of the up-front check no run exists yet, but a second click must not start one.
let starting = false;
const listeners = new Set<() => void>();

function set(next: Partial<MigrationApplyState>) {
	const merged = { ...state, ...next };
	state = { ...merged, applying: merged.running || merged.remote };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function warnBeforeLeaving(event: BeforeUnloadEvent) {
	event.preventDefault();
	event.returnValue = "";
}

/** Web Locks are held for exactly as long as the tab runs, however its timers are throttled; the flag is the fallback. */
function locksSupported(): boolean {
	return typeof navigator !== "undefined" && "locks" in navigator;
}

function writeRunFlag() {
	if (locksSupported()) return;
	try {
		localStorage.setItem(MIGRATION_RUN_FLAG, String(Date.now()));
	} catch {
		// Without storage other tabs simply do not learn about the run.
	}
}

function clearRunFlag() {
	if (locksSupported()) return;
	try {
		localStorage.removeItem(MIGRATION_RUN_FLAG);
	} catch {
		// See writeRunFlag.
	}
}

// Locks raise no event when they are taken or released, so tabs tell each other (the lock stays the truth).
let channel: BroadcastChannel | null | undefined;

function runChannel(): BroadcastChannel | null {
	if (channel === undefined)
		channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(MIGRATION_RUN_LOCK);
	return channel;
}

function tellOtherTabs() {
	runChannel()?.postMessage("changed");
}

async function isRunningInAnotherTab(): Promise<boolean> {
	if (locksSupported()) {
		try {
			return (await navigator.locks.query()).held?.some((lock) => lock.name === MIGRATION_RUN_LOCK) ?? false;
		} catch {
			return false;
		}
	}
	try {
		return isRunFlagActive(localStorage.getItem(MIGRATION_RUN_FLAG), Date.now());
	} catch {
		return false;
	}
}

/** Another tab started or finished an update; a finished one means this tab's lists are stale. */
async function syncRemote() {
	if (state.running) return;
	const remote = await isRunningInAnotherTab();
	// This tab may have started its own run while the lock manager answered.
	if (state.running || remote === state.remote) return;
	set(remote ? { remote } : { remote, refreshTick: state.refreshTick + 1 });
}

async function readPending(): Promise<string[] | null> {
	const response = await fetch(STATUS_API, { cache: "no-store", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
	if (!response.ok) return null;
	const status = (await response.json()) as { pending?: unknown };
	return Array.isArray(status.pending)
		? status.pending.filter((name): name is string => typeof name === "string")
		: null;
}

type PostResult = { transient: true } | { transient: false; ok: boolean; status: number; body: MigrationApplyResult };

async function postApply(signal: AbortSignal): Promise<PostResult> {
	let response: Response;
	try {
		response = await fetch(STATUS_API, { method: "POST", signal });
	} catch {
		return { transient: true };
	}
	if (isTransientStatus(response.status)) return { transient: true };
	const body = (await response.json().catch(() => ({}))) as MigrationApplyResult;
	return { transient: false, ok: response.ok, status: response.status, body };
}

/**
 * The request ended without an answer while the server may still be migrating: keep watching the pending list
 * until it is empty (done) or stops shrinking for a while (unknown).
 */
function watchUntilSettled(
	startNames: string[],
	startedAt: number,
	listen: (handler: (pending: string[] | null) => void) => void,
): Promise<MigrationApplyOutcome> {
	set({ recovering: true });
	const stall = createStallTracker({
		stallMs: MIGRATION_STALL_MS,
		capMs: MIGRATION_RECOVERY_CAP_MS,
		startedAt: Date.now(),
		startCount: state.remaining?.length ?? startNames.length,
	});
	return new Promise((resolve) => {
		listen((pending) => {
			if (pending && pending.length === 0) {
				const result = { ready: true, pending: [], unknown: [], applied: startNames };
				const seconds = (Date.now() - startedAt) / 1000;
				resolve({ ok: true, result, summary: migrationRecoveredSummary(startNames, seconds) });
			} else if (stall.observe(pending ? (state.remaining?.length ?? startNames.length) : null, Date.now())) {
				resolve({ ok: false, error: MIGRATION_OUTCOME_UNKNOWN });
			}
		});
	});
}

/**
 * Applies the pending migrations once, whichever surface asked; a second call while one runs (here or in another
 * tab) does nothing. `onSuccess` runs before the state changes, so a caller can store the result without a flash.
 */
export async function applyMigrations(
	startNames: string[],
	source: MigrationApplySource,
	onSuccess?: (result: MigrationApplyResult) => void,
): Promise<MigrationApplyOutcome | null> {
	if (state.applying || starting) return null;
	// Ask before showing any steps, so a tab that is only watching another tab's run never flashes its own.
	starting = true;
	const elsewhere = await isRunningInAnotherTab().finally(() => (starting = false));
	if (elsewhere) {
		set({ remote: true });
		return null;
	}
	if (state.applying) return null;
	const run = ++runId;
	const startedAt = Date.now();
	set({
		running: true,
		recovering: false,
		source,
		startNames,
		remaining: null,
		startedAt,
		summary: null,
		error: null,
	});
	const outcome = await withRunLock(() => {
		tellOtherTabs();
		return execute(startNames, startedAt);
	});
	if (!outcome) {
		// Another tab holds the run; this one shows it as busy instead.
		set({ running: false, remote: true, source: null, startNames: [], startedAt: null });
		return null;
	}
	tellOtherTabs();
	if (outcome.ok) onSuccess?.(outcome.result);
	const ended = { running: false, recovering: false };
	if (discardedRun === run) set(ended);
	else set(outcome.ok ? { ...ended, summary: outcome.summary } : { ...ended, error: outcome.error });
	return outcome;
}

/** Takes the run lock without waiting; null when another tab holds it. Without Web Locks, the fallback flag decides. */
async function withRunLock(task: () => Promise<MigrationApplyOutcome>): Promise<MigrationApplyOutcome | null> {
	if (!locksSupported()) return (await isRunningInAnotherTab()) ? null : task();
	return navigator.locks.request(MIGRATION_RUN_LOCK, { ifAvailable: true }, (lock) => (lock ? task() : null));
}

/** Posts the request and follows the pending list; the POST is cut off when the list says it is done or it ran too long. */
async function execute(startNames: string[], startedAt: number): Promise<MigrationApplyOutcome> {
	writeRunFlag();
	window.addEventListener("beforeunload", warnBeforeLeaving);
	const controller = new AbortController();
	let handler: ((pending: string[] | null) => void) | null = null;
	let emptySince: number | null = null;
	const stopPolling = startStatusPolling({
		read: readPending,
		delayMs: MIGRATION_POLL_MS,
		onResult: (pending) => {
			const now = Date.now();
			writeRunFlag();
			if (pending) set({ remaining: mergeRemaining(state.remaining, pending) });
			if (pending) emptySince = pending.length === 0 ? (emptySince ?? now) : null;
			handler?.(pending);
			if (!handler && shouldAbortPost({ emptySince, now })) controller.abort();
		},
	});
	try {
		const posted = await postApply(controller.signal);
		if (posted.transient) return await watchUntilSettled(startNames, startedAt, (next) => (handler = next));
		if (posted.ok) {
			return {
				ok: true,
				result: posted.body,
				summary: migrationDoneSummary(posted.body, (Date.now() - startedAt) / 1000),
			};
		}
		return { ok: false, error: migrationApplyFailure(posted.status, posted.body.error) };
	} finally {
		stopPolling();
		clearRunFlag();
		window.removeEventListener("beforeunload", warnBeforeLeaving);
	}
}

export function useMigrationApply(): MigrationApplyState {
	useEffect(() => {
		// A sign-out mid-run must not re-enable the button while the request is still open, so the run goes on;
		// only what it would show is dropped.
		const reset = () => {
			discardedRun = state.running ? runId : discardedRun;
			set({ summary: null, error: null, source: null });
		};
		const recheckNow = () => void syncRemote();
		const onStorage = (event: StorageEvent) => {
			if (event.key === MIGRATION_RUN_FLAG || event.key === null) recheckNow();
		};
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
		window.addEventListener("storage", onStorage);
		// Looking again now and then costs nothing: the lock (or the flag's age) is the truth, not a timer in this tab.
		const recheck = setInterval(recheckNow, 5000);
		document.addEventListener("visibilitychange", recheckNow);
		const pings = runChannel();
		pings?.addEventListener("message", recheckNow);
		recheckNow();
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
			window.removeEventListener("storage", onStorage);
			document.removeEventListener("visibilitychange", recheckNow);
			pings?.removeEventListener("message", recheckNow);
			clearInterval(recheck);
		};
	}, []);
	return useSyncExternalStore(
		subscribe,
		() => state,
		() => IDLE,
	);
}

/** Whole seconds since `startedAt`, ticking once a second while a run is going. */
export function useElapsedSeconds(startedAt: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [startedAt]);
	return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
