"use client";

import { useHydrated } from "@/hooks/use-hydrated";
import { BUILD_COMMIT, BUILD_VERSION } from "@/lib/build-version";
import { useStartupStats } from "./startup-stats";
import type { StartupStep } from "./startup-steps-types";
import { currentStartupStep, planStartupSteps } from "./startup-steps-utils";

/**
 * The startup screen's step log for this start. The server and the hydrating render know nothing (not mounted,
 * no stats); later renders read what AuthGuard, the mailbox provider, the counts and the pending-migrations query
 * published (startup-stats.ts). `completedAt` is the visible time at which the screen completed, or null.
 */
export function useStartupSteps(
	ready: boolean,
	completedAt: number | null,
): { steps: StartupStep[]; statusLabel: string } {
	const mounted = useHydrated();
	const stats = useStartupStats();
	const steps = planStartupSteps({
		mounted,
		ready,
		complete: completedAt !== null,
		version: BUILD_VERSION,
		commit: BUILD_COMMIT,
		stats,
		elapsedMs: completedAt ?? 0,
	});
	return { steps, statusLabel: currentStartupStep(steps)?.label ?? "Loading" };
}
