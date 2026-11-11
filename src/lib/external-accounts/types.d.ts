import type { MailSocketSecurity } from "@/lib/net/types";

export type ExternalAccountPresetId =
	"gmail" | "google_workspace" | "microsoft" | "icloud" | "yahoo" | "aol" | "fastmail" | "other";

export type ExternalAccountAuthKind = "password" | "oauth_google" | "oauth_microsoft";

export type ExternalAccountStatus = "active" | "paused" | "auth_failed" | "tls_failed" | "error" | "disabled";

export type MailServerSettings = { host: string; port: number; security: MailSocketSecurity };

export type ExternalAccountPreset = {
	id: ExternalAccountPresetId;
	label: string;
	/** Address domains that belong to the provider. */
	domains: string[];
	/** MX hosts (or their parent domains) of custom domains hosted by the provider. */
	mxSuffixes: string[];
	imap: MailServerSettings;
	smtp: MailServerSettings;
	/** Whether Kite saves a copy of mail it sends in the provider's Sent folder (false where the provider does). */
	appendSent: boolean;
	/** The largest message the provider accepts, encoding included (spec §7.3); null leaves it to the server's SIZE. */
	maxMessageBytes: number | null;
	/** The authserv-id of the provider's own Authentication-Results, or null when it is never trusted. */
	authservId: string | null;
	/** False for Microsoft, whose accounts sign in only with OAuth (spec §15.5). */
	passwordSignIn: boolean;
	/** What to enter as the password, shown under the field. */
	passwordHelp: string;
};

/** Why connecting accounts is unavailable to a user, or null when it is allowed. */
export type ConnectRefusal = "no_key" | "install_off" | "not_permitted" | "migration_pending";

/** Which OAuth sign-ins this Kite offers (`/api/external-accounts`): set up by the owner in Admin → General. */
export type OAuthProviders = { microsoft: boolean; google: boolean };

/** An account as the API returns it: never the password, never the cursors. */
export type ExternalAccountView = {
	id: string;
	label: string;
	address: string;
	displayName: string | null;
	preset: ExternalAccountPresetId;
	presetLabel: string;
	mailboxId: string;
	imap: MailServerSettings;
	smtp: MailServerSettings | null;
	username: string;
	/** How Kite signs in: the saved password, or Sign in with Microsoft or Google (spec §15), whose Reconnect starts it again. */
	authKind: ExternalAccountAuthKind;
	status: ExternalAccountStatus;
	statusReason: string | null;
	lastError: string | null;
	/** Whether a password (or, for an OAuth account, its sign-in) is saved (false once it was erased). */
	hasPassword: boolean;
	sync: ExternalAccountSyncView;
	sending: ExternalAccountSending;
	/**
	 * Addresses verified with a code, or waiting for one (spec §7.2): the account's own when its sign-in does not prove
	 * it, and aliases.
	 */
	identities: ExternalIdentityView[];
	/** "Recheck authentication" (spec §6.6.1), for Gmail and Google Workspace accounts only; null once never run. */
	authRecheck: ExternalAccountAuthRecheckView | null;
	createdAt: string;
	updatedAt: string;
};

/** Where "Recheck authentication" stands for one account. */
export type ExternalAccountAuthRecheckView = {
	status: "running" | "done" | "failed";
	scanned: number;
	updated: number;
	skipped: number;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
};

/** The settings a connect or edit request carries, validated (`parseAccountInput`). */
export type ExternalAccountInput = {
	address: string;
	label: string;
	displayName: string | null;
	preset: ExternalAccountPresetId;
	mailboxId: string;
	imap: MailServerSettings;
	smtp: MailServerSettings | null;
	username: string;
};

/** Where checking an account for new mail stands (spec §6.5), for the Connected accounts list and the sidebar notice. */
export type ExternalAccountSyncView = {
	/** False while the owner paused checking. */
	enabled: boolean;
	intervalMinutes: number;
	/** The last check that worked. */
	lastSuccessAt: string | null;
	/** When Kite checks next; null when checking stopped (sign-in, certificate or configuration problem). */
	nextSyncAt: string | null;
	/** Failed checks in a row. */
	failures: number;
	/** `throttled` or `transient` while Kite retries, `config` or `sync` once a problem stopped checking. */
	problem: string | null;
	/** A check is running now. */
	running: boolean;
	/** "Also sync the Spam folder": the provider's Spam folder is checked too, into Kite's Spam (off by default). */
	junk: boolean;
};

/** Why an account's address cannot be chosen as From right now (`sendBlock`), or null when it can. */
export type SendBlock =
	"not_allowed" | "no_smtp" | "send_off" | "alias" | "unproven" | "reconnect" | "paused" | "not_verified";

/** The send-as part of an account as the API returns it (spec §7). */
export type ExternalAccountSending = {
	/** The owner lets Kite send as this address (default on). */
	enabled: boolean;
	/** Save a copy in the provider's Sent folder after each send (default from the preset). */
	appendSent: boolean;
	/** The provider saves every message sent through its SMTP server in Sent itself (Gmail), so no copy is needed. */
	providerSavesSent: boolean;
	/** The SMTP sign-in succeeded with the saved password at the last connection test. */
	verified: boolean;
	/** Why the address is not offered as From, or null when it is. */
	block: SendBlock | null;
};

/** An address an account sends as once its code was entered (`external_identities`). */
export type ExternalIdentityView = {
	id: string;
	address: string;
	/** The name in From for this address; null uses the account's. */
	displayName: string | null;
	/** It is the account's own address, which its sign-in does not prove. */
	accountAddress: boolean;
	/** `pending` while a mailed code can still be entered; `unverified` when a new code is needed. */
	state: "verified" | "pending" | "unverified";
	verifiedAt: string | null;
	codeExpiresAt: string | null;
};

/** A connected address the composer can offer as From (`/api/mailboxes`, `externalIdentities`). */
export type SendIdentity = {
	accountId: string;
	address: string;
	/** The name in From: the account's display name, else the user's. */
	displayName: string | null;
	/** "Gmail", "iCloud Mail", …; the From menu says "via Gmail". */
	presetLabel: string;
	/** False when it is listed only to say what to do ("Reconnect"); it cannot be chosen then. */
	available: boolean;
	/** What the owner has to do first, when it is not available. */
	action: "reconnect" | "test_connection" | "verify" | null;
	hint: string | null;
};

/** What Admin → General shows about Microsoft sign-in. The client secret is never part of it. */
export type MicrosoftClientStatus = {
	/** `env` when the MICROSOFT_OAUTH_* variables are set (they win), `settings` when saved here, else null. */
	source: "env" | "settings" | null;
	/** The Application (client) ID in use; not a secret, shown so the owner can tell which registration it is. */
	clientId: string | null;
	tenant: string | null;
	/** The redirect URI to register on the app, exactly. */
	redirectUri: string;
	/** Whether the redirect URI is under APP_URL (else it is this request's origin, fine for development only). */
	appUrlSet: boolean;
	/** The saved registration cannot be opened (APP_ENCRYPTION_KEY missing or changed). */
	unreadable: boolean;
	/** APP_ENCRYPTION_KEY is set, so a registration can be saved here. */
	keyConfigured: boolean;
	migrationPending: boolean;
};

/** What Admin → General shows about Google sign-in. The client secret is never part of it. */
export type GoogleClientStatus = Omit<MicrosoftClientStatus, "tenant"> & {
	/** The Google Workspace domain sign-in is restricted to, or null for any Google account. */
	hostedDomain: string | null;
};
