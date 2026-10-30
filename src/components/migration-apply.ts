"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import {
	MIGRATION_POLL_MS,
	MIGRATION_RUN_FLAG,
	MIGRATION_STALL_MS,
	createStallTracker,
	isRunFlagActive,
	isTransientStatus,
	mergeRemaining,
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
	/** Another tab is applying updates (a flag in localStorage that it keeps fresh). */
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

function writeRunFlag() {
	try {
		localStorage.setItem(MIGRATION_RUN_FLAG, String(Date.now()));
	} catch {
		// Without storage other tabs simply do not learn about the run.
	}
}

function clearRunFlag() {
	try {
		localStorage.removeItem(MIGRATION_RUN_FLAG);
	} catch {
		// See writeRunFlag.
	}
}

function readRemoteFlag(): boolean {
	try {
		return isRunFlagActive(localStorage.getItem(MIGRATION_RUN_FLAG), Date.now());
	} catch {
		return false;
	}
}

/** Another tab started or finished an update; a finished one means this tab's lists are stale. */
function syncRemote() {
	if (state.running) return;
	const remote = readRemoteFlag();
	if (remote === state.remote) return;
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

async function postApply(): Promise<PostResult> {
	let response: Response;
	try {
		response = await fetch(STATUS_API, { method: "POST" });
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
	const stall = createStallTracker(MIGRATION_STALL_MS, Date.now(), state.remaining?.length ?? startNames.length);
	return new Promise((resolve) => {
		listen((pending) => {
			if (pending && pending.length === 0) {
				const result = { ready: true, pending: [], unknown: [], applied: startNames };
				const seconds = (Date.now() - startedAt) / 1000;
				resolve({ ok: true, result, summary: migrationRecoveredSummary(startNames, seconds) });
			} else if (stall.observe(state.remaining?.length ?? startNames.length, Date.now())) {
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
	if (state.applying || readRemoteFlag()) return null;
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
	writeRunFlag();
	window.addEventListener("beforeunload", warnBeforeLeaving);
	let handler: ((pending: string[] | null) => void) | null = null;
	const stopPolling = startStatusPolling({
		read: readPending,
		delayMs: MIGRATION_POLL_MS,
		onResult: (pending) => {
			writeRunFlag();
			if (pending) set({ remaining: mergeRemaining(state.remaining, pending) });
			handler?.(pending);
		},
	});
	let outcome: MigrationApplyOutcome;
	try {
		const posted = await postApply();
		if (posted.transient) {
			outcome = await watchUntilSettled(startNames, startedAt, (next) => (handler = next));
		} else if (posted.ok) {
			const summary = migrationDoneSummary(posted.body, (Date.now() - startedAt) / 1000);
			outcome = { ok: true, result: posted.body, summary };
		} else {
			outcome = { ok: false, error: migrationApplyFailure(posted.status, posted.body.error) };
		}
	} finally {
		stopPolling();
		clearRunFlag();
		window.removeEventListener("beforeunload", warnBeforeLeaving);
	}
	if (outcome.ok) onSuccess?.(outcome.result);
	const ended = { running: false, recovering: false };
	if (discardedRun === run) set(ended);
	else set(outcome.ok ? { ...ended, summary: outcome.summary } : { ...ended, error: outcome.error });
	return outcome;
}

export function useMigrationApply(): MigrationApplyState {
	useEffect(() => {
		// A sign-out mid-run must not re-enable the button while the request is still open, so the run goes on;
		// only what it would show is dropped.
		const reset = () => {
			discardedRun = state.running ? runId : discardedRun;
			set({ summary: null, error: null, source: null });
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key === MIGRATION_RUN_FLAG || event.key === null) syncRemote();
		};
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
		window.addEventListener("storage", onStorage);
		// A tab that crashed leaves its flag behind; it goes stale on its own, so look again now and then.
		const recheck = setInterval(syncRemote, 5000);
		syncRemote();
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
			window.removeEventListener("storage", onStorage);
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
