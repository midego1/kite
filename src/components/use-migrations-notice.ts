"use client";

import { useCallback, useEffect, useSyncExternalStore, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { applyMigrations, useMigrationApply } from "./migration-apply";
import { publishStartupStats } from "./startup-stats";
import type { PendingMigrationsResponse } from "./migrations-banner-types";
import { PENDING_MIGRATIONS_REFRESH_MS, parsePendingMigrations } from "./migrations-banner-utils";

// The banner and the reading-pane card show the same notice, and the reader can switch
// between them mid-apply (opening a message); the apply state lives in migration-apply.ts.
let visibleCards = 0;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Shared by the mailbox banner, the database card and the admin overview; a finished run invalidates it. */
export const PENDING_MIGRATIONS_QUERY = ["pending-migrations"] as const;

export async function fetchPendingMigrations(): Promise<PendingMigrationsResponse> {
	const response = await fetch("/api/migrations/pending", { cache: "no-store" });
	if (!response.ok) throw new Error(`Pending migrations request failed (${response.status})`);
	return parsePendingMigrations(await response.json());
}

export function useMigrationsNotice() {
	const user = useCurrentUser();
	const isPrimaryAdmin = user?.role === "admin" && user.isPrimaryAdmin;
	// Also resets the shared apply state when the session changes, so a sign-out never leaks a summary or error.
	const progress = useMigrationApply();
	const { data, refetch } = useQuery({
		queryKey: PENDING_MIGRATIONS_QUERY,
		queryFn: fetchPendingMigrations,
		enabled: Boolean(user),
		refetchInterval: PENDING_MIGRATIONS_REFRESH_MS,
		// The app-wide defaults disable refetch on mount; this must be current whenever the mailbox is shown.
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});

	// The startup screen's database line reads this answer; it asks for nothing itself.
	const pending = data?.pending;
	useEffect(() => {
		if (pending !== undefined) publishStartupStats({ pendingMigrations: pending });
	}, [pending]);

	const names = data?.names;
	const apply = useCallback(async () => {
		const outcome = await applyMigrations(names ?? [], "mailbox");
		// The next status answer hides the warning; after a failure it keeps what is still pending.
		if (outcome) await refetch();
	}, [names, refetch]);

	// A run that ended in another tab changed what is pending.
	useEffect(() => {
		if (progress.refreshTick > 0) void refetch();
	}, [progress.refreshTick, refetch]);

	// The admin card owns a run it started; the notice then only shows a busy button, so nothing is said twice.
	const owns = progress.source === "mailbox";
	return {
		user,
		isPrimaryAdmin,
		data,
		progress,
		applying: progress.applying,
		showProgress: progress.applying && owns,
		summary: owns ? progress.summary : null,
		error: owns ? progress.error : null,
		apply,
	};
}

/** Whether a reading-pane card is on screen, in which case the top banner steps aside. */
export function useMigrationsCardVisible(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => visibleCards > 0,
		() => false,
	);
}

/**
 * Counts the card as shown only while it has a size: the empty reading pane can be
 * mounted but hidden (a phone, a collapsed split), and then the banner must stay.
 */
export function useMigrationsCardSlot(ref: RefObject<HTMLElement | null>) {
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		let counted = false;
		const update = () => {
			const shown = element.getClientRects().length > 0 && element.offsetWidth > 0;
			if (shown === counted) return;
			counted = shown;
			visibleCards += shown ? 1 : -1;
			emit();
		};
		const observer = new ResizeObserver(update);
		observer.observe(element);
		update();
		return () => {
			observer.disconnect();
			if (counted) {
				visibleCards -= 1;
				emit();
			}
		};
	}, [ref]);
}
