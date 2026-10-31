import { useSyncExternalStore } from "react";
import type { StartupStats } from "./startup-steps-types";

/*
 * What the startup screen knows about this start, published by the code that learns it anyway: AuthGuard (the
 * session), the mailbox provider (the mailboxes), the message counts (unread) and the pending-migrations query
 * (the database). The screen reads it with useStartupStats and asks for nothing itself, so the start costs no
 * extra request and nothing heavy runs when the screen mounts (the open freeze investigation wants the startup
 * screen to stay cheap). A module-level store, not React state: the publishers live in different subtrees.
 */

const EMPTY: StartupStats = {};
let stats: StartupStats = EMPTY;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Merges what a part of the app learnt into the startup stats; unchanged values cause no re-render. */
export function publishStartupStats(update: Partial<StartupStats>): void {
	let changed = false;
	const next: StartupStats = { ...stats };
	for (const key of Object.keys(update) as (keyof StartupStats)[]) {
		const value = update[key];
		if (value === undefined || next[key] === value) continue;
		(next as Record<string, unknown>)[key] = value;
		changed = true;
	}
	if (!changed) return;
	stats = next;
	emit();
}

/** Back to nothing known: the next sign-in starts over (and tests start clean). */
export function resetStartupStats(): void {
	if (stats === EMPTY) return;
	stats = EMPTY;
	emit();
}

function readStartupStats(): StartupStats {
	return stats;
}

/** The stats as the startup screen sees them; the server, and the first client render, know nothing yet. */
export function useStartupStats(): StartupStats {
	return useSyncExternalStore(subscribe, readStartupStats, () => EMPTY);
}
