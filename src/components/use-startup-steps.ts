"use client";

import { useCallback, useEffect, useRef } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { startVisibleClock, tickVisibleClock, type VisibleClock } from "./loading-recovery-utils";
import { BUILD_COMMIT, BUILD_VERSION } from "@/lib/build-version";
import { useStartupStats } from "./startup-stats";
import type { StartupStep } from "./startup-steps-types";
import { currentStartupStep, planStartupSteps } from "./startup-steps-utils";

/**
 * The startup screen's step log for this start. The server and the hydrating render know nothing (not mounted,
 * no stats); later renders read what AuthGuard, the mailbox provider, the counts and the pending-migrations query
 * published (startup-stats.ts). `visibleMs` is the visible time the start took once the screen completed, or null.
 */
export function useStartupSteps(
	ready: boolean,
	visibleMs: number | null,
): { steps: StartupStep[]; statusLabel: string } {
	const mounted = useHydrated();
	const stats = useStartupStats();
	const steps = planStartupSteps({
		mounted,
		ready,
		complete: visibleMs !== null,
		version: BUILD_VERSION,
		commit: BUILD_COMMIT,
		stats,
		elapsedMs: visibleMs ?? 0,
	});
	return { steps, statusLabel: currentStartupStep(steps)?.label ?? "Loading" };
}

/**
 * Visible time since the startup screen mounted, with the clock of the slow-start recovery
 * (loading-recovery-utils.ts): a tab opened in the background does not count its hidden time. Returns a reader
 * for the current value; one visibilitychange listener, nothing else.
 */
export function useVisibleStartupTime(): () => number {
	const clock = useRef<VisibleClock | null>(null);
	useEffect(() => {
		const visible = () => document.visibilityState !== "hidden";
		clock.current = startVisibleClock(performance.now(), visible());
		const tick = () => {
			if (clock.current) clock.current = tickVisibleClock(clock.current, performance.now(), visible());
		};
		document.addEventListener("visibilitychange", tick);
		return () => document.removeEventListener("visibilitychange", tick);
	}, []);
	return useCallback(() => {
		if (!clock.current) return 0;
		clock.current = tickVisibleClock(clock.current, performance.now(), document.visibilityState !== "hidden");
		return Math.round(clock.current.visibleMs);
	}, []);
}
