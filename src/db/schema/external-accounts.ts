import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { mailboxes, users } from "./index";

/**
 * Connected accounts (migration 0079, docs/specs/external-accounts.md §10.2): an IMAP account at another provider
 * whose credentials Kite keeps, sealed with APP_ENCRYPTION_KEY, so imports (and later sync and send-as) can sign in
 * without asking again. `secret` is never returned by an API, logged or exported in a backup.
 */
export const externalAccounts = sqliteTable(
	"external_accounts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** The Kite mailbox the account's mail goes into; the owner has full access to it. */
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		/**
		 * Lower-case. Unique per install for the known providers, whose own servers prove the address at sign-in; an
		 * "Other" account names its own server, so its address proves nothing and claims nothing (migration 0082).
		 */
		address: text("address").notNull(),
		displayName: text("display_name"),
		preset: text("preset", {
			enum: ["gmail", "google_workspace", "microsoft", "icloud", "yahoo", "aol", "fastmail", "other"],
		}).notNull(),
		authKind: text("auth_kind", { enum: ["password", "oauth_google", "oauth_microsoft"] })
			.notNull()
			.default("password"),
		imapHost: text("imap_host").notNull(),
		imapPort: integer("imap_port").notNull(),
		imapSecurity: text("imap_security", { enum: ["tls", "starttls"] }).notNull(),
		smtpHost: text("smtp_host"),
		smtpPort: integer("smtp_port"),
		smtpSecurity: text("smtp_security", { enum: ["tls", "starttls"] }),
		username: text("username").notNull(),
		/** The sealed password; empty once erased (removed permission, the install switch off for 30 days, a restore). */
		secret: text("secret").notNull().default(""),
		syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(true),
		syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(5),
		syncJunk: integer("sync_junk", { mode: "boolean" }).notNull().default(false),
		sendEnabled: integer("send_enabled", { mode: "boolean" }).notNull().default(true),
		appendSent: integer("append_sent", { mode: "boolean" }).notNull().default(true),
		/** Whether the provider's topmost Authentication-Results may be trusted (from the preset, §6.6). */
		trustAuthResults: integer("trust_auth_results", { mode: "boolean" }).notNull().default(false),
		status: text("status", { enum: ["active", "paused", "auth_failed", "tls_failed", "error", "disabled"] })
			.notNull()
			.default("active"),
		/** Why the account is not active, as a code (`permission_revoked`, `install_off`, `restored`, …). */
		statusReason: text("status_reason"),
		lastError: text("last_error"),
		/** JSON: the last 20 problems, `{ at, message }`. */
		recentErrors: text("recent_errors").notNull().default("[]"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		nextSyncAt: integer("next_sync_at", { mode: "timestamp" }),
		lastSyncAt: integer("last_sync_at", { mode: "timestamp" }),
		lastSuccessAt: integer("last_success_at", { mode: "timestamp" }),
		leaseUntil: integer("lease_until", { mode: "timestamp" }),
		/**
		 * Since when Kite may not use the saved password (the owner's permission revoked, or the install switch off),
		 * whatever the account's status; null while it may. The daily run erases the password 30 days after it.
		 */
		suspendedAt: integer("suspended_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("external_accounts_address_idx")
			.on(t.address)
			.where(sql`${t.preset} <> 'other'`),
		index("external_accounts_user_idx").on(t.userId),
		index("external_accounts_status_idx").on(t.status, t.nextSyncAt),
	],
);

/**
 * Where an account's folders stand at the source: the UIDVALIDITY and the last UID Kite has seen. Connecting stores
 * the INBOX baseline (`UIDNEXT − 1`), so checking for new mail starts with mail that arrives after connecting.
 */
export const externalAccountFolders = sqliteTable(
	"external_account_folders",
	{
		accountId: text("account_id")
			.notNull()
			.references(() => externalAccounts.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		role: text("role", { enum: ["inbox", "junk"] }).notNull(),
		uidvalidity: integer("uidvalidity"),
		lastUid: integer("last_uid"),
		uidnext: integer("uidnext"),
		lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
	},
	(t) => [primaryKey({ columns: [t.accountId, t.name] })],
);

/**
 * Addresses an account may send as once proven by a code mailed to them (migration 0089, spec §7.2, §10.3): a provider
 * alias, or the account's own address when its sign-in does not prove it ("Other" servers, a user name that is not the
 * address). `code_hash` is an HMAC of the pending code, never the code; it and its expiry are cleared once the code is
 * used, and a backup leaves them out.
 */
export const externalIdentities = sqliteTable(
	"external_identities",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id")
			.notNull()
			.references(() => externalAccounts.id, { onDelete: "cascade" }),
		/** Lower-case. */
		address: text("address").notNull(),
		displayName: text("display_name"),
		/** When the code was entered; null while it waits for one. Only a verified address is ever sent as. */
		verifiedAt: integer("verified_at", { mode: "timestamp" }),
		codeHash: text("code_hash"),
		codeExpiresAt: integer("code_expires_at", { mode: "timestamp" }),
		/** Wrong codes entered for the current code; at the limit the code is dropped. */
		attempts: integer("attempts").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("external_identities_account_address_idx").on(t.accountId, t.address)],
);

/**
 * The columns migration 0079 adds to `users` and `app_settings`, as narrow views of those tables. They are kept off
 * `users` and `appSettings` on purpose: Drizzle names every column of a table in whole-row selects and inserts, so a
 * deploy that runs before the migration would fail every sign-in. Only `src/lib/external-accounts/` reads them, and
 * treats a missing column as the default.
 */
export const userConnectPermissions = sqliteTable("users", {
	id: text("id").primaryKey(),
	canConnectAccounts: integer("can_connect_accounts", { mode: "boolean" }).notNull().default(true),
});

export const externalAccountSettings = sqliteTable("app_settings", {
	id: text("id").primaryKey(),
	/** Null follows the default: on when APP_ENCRYPTION_KEY is set. */
	externalAccountsEnabled: integer("external_accounts_enabled", { mode: "boolean" }),
	/** When the owner turned the switch off (each account's own `suspended_at` drives the erase). */
	externalAccountsDisabledAt: integer("external_accounts_disabled_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * Migration 0083's send-as state of an account, a narrow view of `external_accounts` for the same reason: the account
 * pages and the import keep working on a deploy that runs before the migration. `smtpVerifiedAt` is when the SMTP
 * sign-in last succeeded with the saved password (spec §7.2); null means the address is not offered as a sender.
 */
export const externalAccountSendStates = sqliteTable("external_accounts", {
	id: text("id").primaryKey(),
	smtpVerifiedAt: integer("smtp_verified_at", { mode: "timestamp" }),
});

/**
 * `messages.external_account_id` (migration 0079): the connected account a synced message came in by, or a sent copy
 * went out through. A narrow view of `messages` for the same reason as `messageBodyKeys`: whole-row reads and inserts
 * of `messages` must not name a column a deploy can run ahead of. Only written once the account tables exist.
 */
export const messageExternalAccounts = sqliteTable("messages", {
	id: text("id").primaryKey(),
	externalAccountId: text("external_account_id"),
});
