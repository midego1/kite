"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import { migrationApplyFailure, migrationDoneSummary } from "./migration-progress-utils";
import type { MigrationApplyResponse } from "./migrations-banner-types";

const STATUS_API = "/api/admin/migrations";
const POLL_MS = 2000;

/** Which surface started the run; only that one shows the steps and the result, the others just show a busy button. */
export type MigrationApplySource = "admin" | "mailbox";

export interface MigrationApplyState {
	applying: boolean;
	source: MigrationApplySource | null;
	/** The pending migrations when the run started, and the ones still pending at the last poll. */
	startNames: string[];
	remaining: string[] | null;
	startedAt: number | null;
	summary: string | null;
	error: string | null;
}

export type MigrationApplyOutcome =
	{ ok: true; result: MigrationApplyResponse; summary: string } | { ok: false; error: string };

const IDLE: MigrationApplyState = {
	applying: false,
	source: null,
	startNames: [],
	remaining: null,
	startedAt: null,
	summary: null,
	error: null,
};

// The admin card, the reading-pane card and the banner show the same run, and the reader can move between
// them mid-apply, so the state lives outside every component.
let state: MigrationApplyState = IDLE;
let runId = 0;
const listeners = new Set<() => void>();

function set(next: Partial<MigrationApplyState>) {
	state = { ...state, ...next };
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

async function pollRemaining(run: number) {
	try {
		const response = await fetch(STATUS_API, { cache: "no-store" });
		if (!response.ok) return;
		const status = (await response.json()) as { pending?: unknown };
		if (run === runId && state.applying && Array.isArray(status.pending)) {
			set({ remaining: status.pending.filter((name): name is string => typeof name === "string") });
		}
	} catch {
		// Progress is a convenience: a missed poll only means the step text lags.
	}
}

/** Applies the pending migrations once, whichever surface asked; a second call while one runs does nothing. */
export async function applyMigrations(
	startNames: string[],
	source: MigrationApplySource,
): Promise<MigrationApplyOutcome | null> {
	if (state.applying) return null;
	const run = ++runId;
	const startedAt = Date.now();
	set({ applying: true, source, startNames, remaining: null, startedAt, summary: null, error: null });
	window.addEventListener("beforeunload", warnBeforeLeaving);
	const poll = setInterval(() => void pollRemaining(run), POLL_MS);
	let outcome: MigrationApplyOutcome;
	try {
		const response = await fetch(STATUS_API, { method: "POST" });
		const result = (await response.json().catch(() => ({}))) as MigrationApplyResponse;
		outcome = response.ok
			? { ok: true, result, summary: migrationDoneSummary(result, (Date.now() - startedAt) / 1000) }
			: { ok: false, error: migrationApplyFailure(response.status, result.error) };
	} catch {
		outcome = { ok: false, error: migrationApplyFailure(null, undefined) };
	} finally {
		clearInterval(poll);
		window.removeEventListener("beforeunload", warnBeforeLeaving);
	}
	// A sign-out in the meantime reset the state; the result belongs to the previous session.
	if (run === runId) {
		set(outcome.ok ? { applying: false, summary: outcome.summary } : { applying: false, error: outcome.error });
	}
	return outcome;
}

export function useMigrationApply(): MigrationApplyState {
	useEffect(() => {
		const reset = () => {
			runId += 1;
			set(IDLE);
		};
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
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
