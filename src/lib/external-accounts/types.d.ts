import type { MailSocketSecurity } from "@/lib/net/types";

export type ExternalAccountPresetId =
	"gmail" | "google_workspace" | "microsoft" | "icloud" | "yahoo" | "aol" | "fastmail" | "other";

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
	status: ExternalAccountStatus;
	statusReason: string | null;
	lastError: string | null;
	/** Whether a password is saved (false once it was erased). */
	hasPassword: boolean;
	sending: ExternalAccountSending;
	createdAt: string;
	updatedAt: string;
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

/** Why an account's address cannot be chosen as From right now (`sendBlock`), or null when it can. */
export type SendBlock = "not_allowed" | "no_smtp" | "send_off" | "alias" | "reconnect" | "paused" | "not_verified";

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
	action: "reconnect" | "test_connection" | null;
	hint: string | null;
};
