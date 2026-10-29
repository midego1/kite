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
	sync: ExternalAccountSyncView;
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
};
