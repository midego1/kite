import type { OAuthCallbackFailure, OAuthCallbackOutcome } from "./oauth-flow";
import type { OAuthProviderId } from "./oauth-provider-utils";

const SETTINGS_PATH = "/settings/connected-accounts";

/**
 * The Connected accounts page with the outcome of a sign-in in its query: an account id, or a failure code, and the
 * provider once it is known (a missing state names none).
 */
export function oauthResultPath(outcome: OAuthCallbackOutcome): string {
	const query = outcome.ok
		? new URLSearchParams({ oauth: outcome.reconnected ? "reconnected" : "connected", account: outcome.accountId })
		: new URLSearchParams({ oauth: "failed", reason: outcome.reason });
	if (outcome.provider) query.set("provider", outcome.provider);
	return `${SETTINGS_PATH}?${query}`;
}

/** What the page says for each failure of a Microsoft sign-in; a code it does not know reads as the generic one. */
const MICROSOFT_FAILURE_TEXT: Record<OAuthCallbackFailure, string> = {
	expired: "The Microsoft sign-in expired or was already used. Start it again from Connect account.",
	cancelled: "The Microsoft sign-in was cancelled. Nothing was connected.",
	admin_consent:
		"Your organisation needs an administrator to approve Kite's app first (admin consent in Microsoft Entra). Ask them, then try again.",
	denied: "Microsoft did not sign you in. Nothing was connected.",
	not_configured: "Microsoft sign-in is not set up on this Kite. Ask your admin.",
	token: "Microsoft did not accept this Kite's sign-in. Ask your admin to check Microsoft sign-in in Admin → General.",
	no_address: "Microsoft did not say which address you signed in with. Try again.",
	wrong_domain: "Microsoft did not say which address you signed in with. Try again.",
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

/** The same for a Google sign-in (spec §15.7). */
const GOOGLE_FAILURE_TEXT: Record<OAuthCallbackFailure, string> = {
	expired: "The Google sign-in expired or was already used. Start it again from Connect account.",
	cancelled: "The Google sign-in was cancelled. Nothing was connected.",
	admin_consent:
		"Google did not let this account use Kite's app: a Google Workspace administrator has to allow it, or the app only accepts accounts of its own organisation. Ask your admin.",
	denied: "Google did not sign you in. Nothing was connected.",
	not_configured: "Google sign-in is not set up on this Kite. Ask your admin.",
	token: "Google did not accept this Kite's sign-in. Ask your admin to check Google sign-in in Admin → General.",
	no_address: "Google did not confirm a verified address for the account you signed in with. Try again.",
	wrong_domain: "This Kite only connects Google accounts of the Workspace domain your admin chose.",
	no_refresh_token:
		"Google did not allow Kite to stay signed in (offline access). Remove Kite at myaccount.google.com/permissions, then connect again.",
	scopes:
		"Google did not grant access to Gmail. Connect again and allow Kite to read, compose, send and delete your Gmail mail.",
	different_account: "You signed in with a different Google account than the one you are reconnecting.",
	imap_refused:
		"Google signed you in, but Gmail refused Kite's IMAP sign-in. For a Google Workspace account, an administrator may have to allow IMAP access.",
	not_allowed: "Connected accounts are not available to you right now.",
	kite_domain: "This address is on a domain of this Kite, so its mail already arrives here.",
	address_taken:
		"This Google account is already connected. To switch it from an app password to Google sign-in, edit it and choose Sign in with Google.",
	migration_pending: "Apply the pending database update to use Google sign-in.",
	failed: "Something went wrong connecting the Google account. Try again.",
};

/** When the state was not found, the page cannot tell which provider it was. */
const UNKNOWN_FAILURE_TEXT: Partial<Record<OAuthCallbackFailure, string>> = {
	expired: "The sign-in expired or was already used. Start it again from Connect account.",
	migration_pending: "Apply the pending database update to use sign-in with Microsoft or Google.",
	failed: "Something went wrong connecting the account. Try again.",
};

const LABELS: Record<OAuthProviderId, string> = { microsoft: "Microsoft", google: "Google" };

const providerOf = (query: URLSearchParams): OAuthProviderId | null => {
	const value = query.get("provider");
	return value === "microsoft" || value === "google" ? value : null;
};

function failureText(reason: string, provider: OAuthProviderId | null): string {
	if (!provider) {
		const texts = UNKNOWN_FAILURE_TEXT as Record<string, string>;
		return texts[reason] ?? texts.failed;
	}
	const texts = (provider === "google" ? GOOGLE_FAILURE_TEXT : MICROSOFT_FAILURE_TEXT) as Record<string, string>;
	return texts[reason] ?? texts.failed;
}

/** The page's message for `?oauth=…&reason=…&provider=…`, or null when the query holds no sign-in outcome. */
export function oauthResultMessage(
	query: URLSearchParams,
): { tone: "success" | "error"; text: string; accountId: string | null } | null {
	const oauth = query.get("oauth");
	const provider = providerOf(query);
	if (oauth === "connected" || oauth === "reconnected") {
		const label = provider ? `${LABELS[provider]} account` : "Account";
		return {
			tone: "success",
			text: oauth === "connected" ? `${label} connected.` : `${label} reconnected.`,
			accountId: query.get("account"),
		};
	}
	if (oauth !== "failed") return null;
	return { tone: "error", text: failureText(query.get("reason") ?? "failed", provider), accountId: null };
}
