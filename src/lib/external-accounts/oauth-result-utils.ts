import type { OAuthCallbackFailure, OAuthCallbackOutcome } from "./oauth-flow";

const SETTINGS_PATH = "/settings/connected-accounts";

/** The Connected accounts page with the outcome of a sign-in in its query: an account id, or a failure code. */
export function oauthResultPath(outcome: OAuthCallbackOutcome): string {
	const query = outcome.ok
		? new URLSearchParams({ oauth: outcome.reconnected ? "reconnected" : "connected", account: outcome.accountId })
		: new URLSearchParams({ oauth: "failed", reason: outcome.reason });
	return `${SETTINGS_PATH}?${query}`;
}

/** What the page says for each failure; a code it does not know reads as the generic one. */
const OAUTH_FAILURE_TEXT: Record<OAuthCallbackFailure, string> = {
	expired: "The Microsoft sign-in expired or was already used. Start it again from Connect account.",
	cancelled: "The Microsoft sign-in was cancelled. Nothing was connected.",
	admin_consent:
		"Your organisation needs an administrator to approve Kite's app first (admin consent in Microsoft Entra). Ask them, then try again.",
	denied: "Microsoft did not sign you in. Nothing was connected.",
	not_configured: "Microsoft sign-in is not set up on this Kite. Ask your admin.",
	token: "Microsoft did not accept this Kite's sign-in. Ask your admin to check Microsoft sign-in in Admin → General.",
	no_address: "Microsoft did not say which address you signed in with. Try again.",
	no_refresh_token:
		"Microsoft did not allow Kite to stay signed in (offline access). Ask your admin to check the app's permissions.",
	scopes: "Microsoft did not grant access to IMAP. Ask your admin to add the IMAP.AccessAsUser.All permission.",
	different_account: "You signed in with a different Microsoft account than the one you are reconnecting.",
	imap_refused:
		"Microsoft signed you in, but Outlook refused Kite's IMAP sign-in. For a work or school account, an administrator may have to enable IMAP for the mailbox.",
	not_allowed: "Connected accounts are not available to you right now.",
	kite_domain: "This address is on a domain of this Kite, so its mail already arrives here.",
	address_taken: "This Microsoft account is already connected.",
	migration_pending: "Apply the pending database update to use Microsoft sign-in.",
	failed: "Something went wrong connecting the Microsoft account. Try again.",
};

/** The page's message for `?oauth=…&reason=…`, or null when the query holds no sign-in outcome. */
export function oauthResultMessage(
	query: URLSearchParams,
): { tone: "success" | "error"; text: string; accountId: string | null } | null {
	const oauth = query.get("oauth");
	if (oauth === "connected" || oauth === "reconnected")
		return {
			tone: "success",
			text: oauth === "connected" ? "Microsoft account connected." : "Microsoft account reconnected.",
			accountId: query.get("account"),
		};
	if (oauth !== "failed") return null;
	const reason = query.get("reason") ?? "failed";
	const text = (OAUTH_FAILURE_TEXT as Record<string, string>)[reason] ?? OAUTH_FAILURE_TEXT.failed;
	return { tone: "error", text, accountId: null };
}
