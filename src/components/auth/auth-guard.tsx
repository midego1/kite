"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AuthGuardProps } from "./auth-guard-types";
import { getAuthGuardDecision } from "./auth-guard-utils";
import { LoadingTransition } from "@/components/loading-transition";
import { StartupFailure } from "@/components/startup-failure";
import { ModulesProvider } from "@/components/modules/modules-context";
import { useAuthMe } from "@/hooks/use-auth-me";
import { saveUserTimeZonePreference } from "@/lib/time/client";

export function AuthGuard({
	children,
	mode = "protected",
	requireMailbox,
	requireRole,
	requirePrimary,
	allowAuthenticated,
}: AuthGuardProps) {
	const pathname = usePathname();
	const router = useRouter();
	const session = useAuthMe();
	const [continued, setContinued] = useState(false);
	// Derived rather than stored, so a guard remounted by a route-group change renders
	// straight from the cached session instead of flashing the loading state.
	const decision = getAuthGuardDecision({
		mode,
		status: session.status,
		session: session.data,
		pathname,
		requireMailbox,
		requireRole,
		requirePrimary,
		allowAuthenticated,
		continueWithoutSession: continued,
	});
	const user = session.data?.user;
	const { refetch } = session;
	// Joins an attempt already running instead of restarting it.
	const retry = useCallback(() => void refetch({ cancelRefetch: false }), [refetch]);
	const failed = session.status === "error" && session.data === undefined;

	// Without an answer, coming back to the tab or online tries again: the error state ends by itself, and a page
	// opened with "Continue anyway" gets its account menus once the server answers.
	useEffect(() => {
		if (!failed && !(continued && session.data === undefined)) return;
		const retryWhenVisible = () => {
			if (document.visibilityState !== "hidden") retry();
		};
		window.addEventListener("online", retry);
		window.addEventListener("focus", retryWhenVisible);
		document.addEventListener("visibilitychange", retryWhenVisible);
		return () => {
			window.removeEventListener("online", retry);
			window.removeEventListener("focus", retryWhenVisible);
			document.removeEventListener("visibilitychange", retryWhenVisible);
		};
	}, [failed, continued, session.data, retry]);

	useEffect(() => {
		if (user?.id) saveUserTimeZonePreference(user.id, user.timeZone ?? null);
	}, [user?.id, user?.timeZone]);

	useEffect(() => {
		if (decision.redirect) router.replace(decision.redirect);
	}, [decision.redirect, router]);

	useEffect(() => {
		const refreshTimeZone = (event: StorageEvent) => {
			if (event.key === "kite-user-time-zone") window.location.reload();
		};
		window.addEventListener("storage", refreshTimeZone);
		return () => window.removeEventListener("storage", refreshTimeZone);
	}, []);

	return (
		<ModulesProvider modules={session.data?.modules}>
			{mode === "public" ? (
				children
			) : (
				<LoadingTransition
					ready={decision.authorized}
					failure={
						decision.unreachable ? <StartupFailure onRetry={retry} onContinue={() => setContinued(true)} /> : null
					}
				>
					{children}
				</LoadingTransition>
			)}
		</ModulesProvider>
	);
}
