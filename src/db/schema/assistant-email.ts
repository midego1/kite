import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { agentConversations, domains, mailboxes, users } from "./index";

/**
 * Assistant by email (docs/specs/assistant-by-email.md, migration 0096): one assistant address per domain, shared by
 * every user who opts in (`user_ai_settings.assistant_email_enabled`). `enabled` lets an admin turn an address off
 * without losing its history; disabling never deletes the row, so it cannot be recreated by someone else.
 */
export const assistantAddresses = sqliteTable(
	"assistant_addresses",
	{
		id: text("id").primaryKey(),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		localPart: text("local_part").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("assistant_addresses_address_idx").on(t.domainId, t.localPart)],
);

/**
 * A verified extra address (spec §5.3), for a user who wants to reach the assistant from somewhere other than a
 * Kite mailbox (their phone's mail account, for example). An address counts only once `verifiedAt` is set, by
 * confirming the single-use code sent to it; at most 5 per user (enforced where rows are inserted), and an address
 * belongs to at most one user in the install (the unique index). Never a domain of this install itself (checked
 * where rows are inserted, and again by sender mapping): a shared mailbox there would let anyone with send-as
 * access verify its address as their own and command another user's assistant. `attempts` (migration 0097) counts
 * wrong guesses against the current code only, reset to 0 whenever a new one is mailed.
 */
export const assistantSenderAddresses = sqliteTable(
	"assistant_sender_addresses",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		address: text("address").notNull(),
		codeHash: text("code_hash"),
		codeExpiresAt: integer("code_expires_at", { mode: "timestamp" }),
		attempts: integer("attempts").notNull().default(0),
		verifiedAt: integer("verified_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("assistant_sender_addresses_address_idx").on(t.address),
		index("assistant_sender_addresses_user_idx").on(t.userId),
	],
);

/**
 * One row per request the assistant accepted (spec §4, §12): a request that fails authentication, sender mapping,
 * or a guard never gets one, so this table only ever holds mail Kite is willing to act on. `rawR2Key` is cleared
 * once the queue consumer has read it (or by the stale-raw sweep in `pruning.ts` after 7 days if a job never
 * finished); the row itself outlives it for 30 days, like a chat conversation. `replyMessageId` is the assistant's
 * own reply's Message-ID, so a later message whose `In-Reply-To` names it is recognised as a follow-up instead of
 * a fresh request.
 */
export const assistantEmailRequests = sqliteTable(
	"assistant_email_requests",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		assistantAddressId: text("assistant_address_id").references(() => assistantAddresses.id, { onDelete: "set null" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		conversationId: text("conversation_id").references(() => agentConversations.id, { onDelete: "set null" }),
		rawR2Key: text("raw_r2_key"),
		providerMessageId: text("provider_message_id").notNull(),
		replyMessageId: text("reply_message_id"),
		fromAddr: text("from_addr").notNull(),
		subject: text("subject"),
		status: text("status", { enum: ["queued", "running", "answered", "failed", "refused"] })
			.notNull()
			.default("queued"),
		reason: text("reason"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		completedAt: integer("completed_at", { mode: "timestamp" }),
	},
	(t) => [
		uniqueIndex("assistant_email_requests_message_idx").on(t.userId, t.providerMessageId),
		index("assistant_email_requests_user_idx").on(t.userId, t.createdAt),
		index("assistant_email_requests_reply_idx").on(t.replyMessageId),
	],
);
