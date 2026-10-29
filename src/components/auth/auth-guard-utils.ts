import type { AuthGuardDecision, AuthGuardDecisionInput } from "./auth-guard-types";

/**
 * The decision while there is no answer to go by, or null once there is. Without an answer yet, the user's
 * "Continue anyway" renders the page (API calls still enforce auth); it also keeps the page while a later attempt
 * runs, which puts the query back into its pending state. A failed check with no earlier answer renders public
 * pages and shows the error state (Try again, Continue anyway) on protected ones rather than a loader that never
 * ends. A failed refetch keeps the last answer, which decides as usual.
 */
function decideWithoutAnswer({
	mode,
	status,
	session,
	continueWithoutSession = false,
}: AuthGuardDecisionInput): AuthGuardDecision | null {
	if (session === undefined && continueWithoutSession) return { authorized: true, redirect: null };
	if (status === "pending") return { authorized: mode === "public", redirect: null };
	if (status !== "error" || session !== undefined) return null;
	return mode === "public"
		? { authorized: true, redirect: null }
		: { authorized: false, redirect: null, unreachable: true };
}

/** Pure routing decision for AuthGuard, derived from the shared session query. */
export function getAuthGuardDecision(input: AuthGuardDecisionInput): AuthGuardDecision {
	const early = decideWithoutAnswer(input);
	if (early) return early;
	const { mode, session, pathname, requireMailbox, requireRole, requirePrimary, allowAuthenticated } = input;
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
