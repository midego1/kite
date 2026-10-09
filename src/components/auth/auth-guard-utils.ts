import type { AuthGuardDecision, AuthGuardDecisionInput } from "./auth-guard-types";

/** Pure routing decision for AuthGuard, derived from the shared session query. */
export function getAuthGuardDecision({
	mode,
	status,
	session,
	pathname,
	requireMailbox,
	requireRole,
	requirePrimary,
	allowAuthenticated,
}: AuthGuardDecisionInput): AuthGuardDecision {
	if (status === "pending") return { authorized: mode === "public", redirect: null };
	// An unreachable session check must not lock the user out; API calls still enforce auth.
	if (status === "error") return { authorized: true, redirect: null };
	if (!session) {
		return mode === "protected" ? { authorized: false, redirect: "/login" } : { authorized: true, redirect: null };
	}
	if (mode === "public") return { authorized: true, redirect: allowAuthenticated ? null : "/inbox" };

	const { user } = session;
	if (
		requireMailbox &&
		session.hasMailboxes === false &&
		user.role === "admin" &&
		session.isSetup === false &&
		pathname !== "/setup"
	) {
		return { authorized: false, redirect: "/setup" };
	}
	if (pathname === "/setup" && session.isSetup === true) return { authorized: false, redirect: "/inbox" };
	if (requireRole && user.role !== requireRole) return { authorized: false, redirect: "/inbox" };
	if (requirePrimary && !user.isPrimaryAdmin) return { authorized: false, redirect: "/admin" };
	return { authorized: true, redirect: null };
}
