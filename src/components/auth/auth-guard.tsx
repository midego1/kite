"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { AuthGuardProps } from "./auth-guard-types";
import { getAuthGuardDecision } from "./auth-guard-utils";
import { LoadingTransition } from "@/components/loading-transition";
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
	});
	const user = session.data?.user;

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

	if (mode === "public") return <>{children}</>;
	return <LoadingTransition ready={decision.authorized}>{children}</LoadingTransition>;
}
