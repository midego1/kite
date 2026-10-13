"use client";

import { useCallback, useEffect, useSyncExternalStore, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { MigrationApplyResponse, PendingMigrationsResponse } from "./migrations-banner-types";
import {
	PENDING_MIGRATIONS_REFRESH_MS,
	migrationApplySummary,
	parsePendingMigrations,
} from "./migrations-banner-utils";

type ApplyState = { applying: boolean; summary: string | null; error: string | null };

// The banner and the reading-pane card show the same notice, and the reader can switch
// between them mid-apply (opening a message), so the apply state lives outside both.
let applyState: ApplyState = { applying: false, summary: null, error: null };
let visibleCards = 0;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function setApplyState(next: Partial<ApplyState>) {
	applyState = { ...applyState, ...next };
	emit();
}

async function fetchPendingMigrations(): Promise<PendingMigrationsResponse> {
	const response = await fetch("/api/migrations/pending", { cache: "no-store" });
	if (!response.ok) throw new Error(`Pending migrations request failed (${response.status})`);
	return parsePendingMigrations(await response.json());
}

export function useMigrationsNotice() {
	const user = useCurrentUser();
	const isPrimaryAdmin = user?.role === "admin" && user.isPrimaryAdmin;
	const state = useSyncExternalStore(
		subscribe,
		() => applyState,
		() => applyState,
	);
	const { data, refetch } = useQuery({
		queryKey: ["pending-migrations"],
		queryFn: fetchPendingMigrations,
		enabled: Boolean(user),
		refetchInterval: PENDING_MIGRATIONS_REFRESH_MS,
		// The app-wide defaults disable refetch on mount; this must be current whenever the mailbox is shown.
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});

	const apply = useCallback(async () => {
		if (applyState.applying) return;
		setApplyState({ applying: true, error: null });
		try {
			const response = await fetch("/api/admin/migrations", { method: "POST" });
			const result = (await response.json()) as MigrationApplyResponse;
			if (!response.ok) throw new Error(result.error ?? "Could not apply the database updates");
			setApplyState({ summary: migrationApplySummary(result) });
			// The next status answer hides the warning; a failure keeps it with the names.
			await refetch();
		} catch (failure) {
			setApplyState({
				error: failure instanceof Error ? failure.message : "Could not apply the database updates",
			});
		} finally {
			setApplyState({ applying: false });
		}
	}, [refetch]);

	return { user, isPrimaryAdmin, data, ...state, apply };
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
