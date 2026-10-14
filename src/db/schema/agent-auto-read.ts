import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AgentActionType } from "@/lib/agent/auto-read/policy-types";
import type { SuggestionKind } from "@/lib/agent/auto-read/suggestion-types";
import { agentJobs, mailboxes, messages, users } from "./index";

export const agentSuggestions = sqliteTable(
	"agent_suggestions",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		threadId: text("thread_id"),
		jobId: text("job_id").references(() => agentJobs.id, { onDelete: "set null" }),
		reviewerUserId: text("reviewer_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** A core kind or one a module declares; there is no SQL CHECK. */
		kind: text("kind").$type<SuggestionKind>().notNull(),
		status: text("status", { enum: ["open", "accepted", "dismissed", "expired", "superseded", "auto_applied"] })
			.notNull()
			.default("open"),
		title: text("title").notNull(),
		/** JSON, validated per kind. */
		payload: text("payload").notNull().default("{}"),
		draftId: text("draft_id").references(() => messages.id, { onDelete: "set null" }),
		confidence: integer("confidence"),
		model: text("model"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		decidedAt: integer("decided_at", { mode: "timestamp" }),
		decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
	},
	(t) => [
		uniqueIndex("agent_suggestions_message_kind_idx").on(t.messageId, t.kind),
		index("agent_suggestions_mailbox_status_idx").on(t.mailboxId, t.status, t.createdAt),
	],
);

export const agentActions = sqliteTable(
	"agent_actions",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		suggestionId: text("suggestion_id").references(() => agentSuggestions.id, { onDelete: "set null" }),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		jobId: text("job_id"),
		initiator: text("initiator", { enum: ["agent", "user"] }).notNull(),
		/** Whose permission the action used. */
		actingUserId: text("acting_user_id").references(() => users.id, { onDelete: "set null" }),
		autonomy: text("autonomy", { enum: ["off", "suggest", "act", "auto"] }),
		/** A core action type or one a module's `action` descriptor registers, checked against `ACTION_REGISTRY`. */
		action: text("action").$type<AgentActionType>().notNull(),
		/** Outcome for actions that have more than one, e.g. the PARTSTAT of send_rsvp. */
		variant: text("variant").notNull().default(""),
		status: text("status", { enum: ["pending", "applied", "undone", "failed", "blocked"] })
			.notNull()
			.default("pending"),
		before: text("before"),
		after: text("after"),
		/** Policy rule id that allowed or blocked the action. */
		reason: text("reason"),
		undoUntil: integer("undo_until", { mode: "timestamp" }),
		undoneAt: integer("undone_at", { mode: "timestamp" }),
		undoneByUserId: text("undone_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("agent_actions_mailbox_created_idx").on(t.mailboxId, t.createdAt),
		// Only live rows are unique, so an outcome can run again after its earlier action was undone or failed.
		uniqueIndex("agent_actions_live_idx")
			.on(t.suggestionId, t.action, t.variant)
			.where(sql`status IN ('pending', 'applied')`),
	],
);

export const agentSenderPolicies = sqliteTable(
	"agent_sender_policies",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		/** Normalised `addr@example.com` or `@example.com`. */
		pattern: text("pattern").notNull(),
		requireAuth: integer("require_auth", { mode: "boolean" }).notNull().default(true),
		/** JSON array of action names the sender may trigger without review. */
		allowedActions: text("allowed_actions").notNull().default("[]"),
		templateRule: text("template_rule"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("agent_sender_policies_pattern_idx").on(t.mailboxId, t.pattern)],
);
