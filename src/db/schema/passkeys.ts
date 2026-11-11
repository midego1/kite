import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { users } from "./index";

/**
 * WebAuthn credentials (migration 0112). Only the public key is stored, as the COSE key the authenticator
 * returned; `sign_count` is the last counter seen (0 for synced passkeys, which do not count).
 */
export const passkeys = sqliteTable(
	"passkeys",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Base64url credential id. */
		credentialId: text("credential_id").notNull().unique(),
		/** Base64url COSE public key. */
		publicKey: text("public_key").notNull(),
		algorithm: integer("algorithm").notNull(),
		signCount: integer("sign_count").notNull().default(0),
		/** JSON array of the transports the browser reported, passed back as hints. */
		transports: text("transports"),
		aaguid: text("aaguid"),
		backupEligible: integer("backup_eligible", { mode: "boolean" }).notNull().default(false),
		backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
		name: text("name").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
	},
	(t) => [index("passkeys_user_idx").on(t.userId)],
);

/**
 * A WebAuthn ceremony in progress: the challenge the browser must sign, found by the SHA-256 of a token only the
 * client holds (an httpOnly cookie for sign-in, the response body for registration). Single-use and short-lived;
 * a registration challenge is also bound to the user and the session that asked for it.
 */
export const passkeyChallenges = sqliteTable(
	"passkey_challenges",
	{
		id: text("id").primaryKey(),
		tokenHash: text("token_hash").notNull().unique(),
		purpose: text("purpose", { enum: ["register", "authenticate"] }).notNull(),
		challenge: text("challenge").notNull(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		sessionHash: text("session_hash"),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("passkey_challenges_expires_idx").on(t.expiresAt)],
);
