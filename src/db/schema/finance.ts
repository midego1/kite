import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { calendarEvents, contacts, mailboxes, messages, users } from "./index";

/** A subscription the user chose to track in Money Watch. */
export const financeSubscriptions = sqliteTable(
	"finance_subscriptions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
		vendor: text("vendor").notNull(),
		vendorKey: text("vendor_key").notNull(),
		plan: text("plan"),
		amountMinor: integer("amount_minor"),
		currency: text("currency"),
		cycle: text("cycle", { enum: ["weekly", "monthly", "quarterly", "yearly"] }),
		/** 00:00 UTC of the renewal date. */
		nextRenewalAt: integer("next_renewal_at", { mode: "timestamp" }),
		renewalEstimated: integer("renewal_estimated", { mode: "boolean" }).notNull().default(false),
		trialEndsAt: integer("trial_ends_at", { mode: "timestamp" }),
		status: text("status", { enum: ["active", "trial", "cancelled", "expired"] })
			.notNull()
			.default("active"),
		/** Non-null means the subscription needs attention. */
		paymentFailedAt: integer("payment_failed_at", { mode: "timestamp" }),
		reminderDays: integer("reminder_days").notNull().default(3),
		calendarReminder: integer("calendar_reminder", { mode: "boolean" }).notNull().default(true),
		/** The due date the last reminder covered, so a cron tick never reminds twice. */
		lastRemindedFor: integer("last_reminded_for", { mode: "timestamp" }),
		calendarEventId: text("calendar_event_id").references(() => calendarEvents.id, { onDelete: "set null" }),
		/** Taken only from an https `List-Unsubscribe` header. */
		cancelUrl: text("cancel_url"),
		cancelOneClick: integer("cancel_one_click", { mode: "boolean" }).notNull().default(false),
		previousAmountMinor: integer("previous_amount_minor"),
		priceChangedAt: integer("price_changed_at", { mode: "timestamp" }),
		sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
		lastMessageId: text("last_message_id").references(() => messages.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("finance_subscriptions_user_vendor_idx").on(t.userId, t.vendorKey),
		index("finance_subscriptions_due_idx").on(t.status, t.nextRenewalAt),
		index("finance_subscriptions_trial_idx").on(t.status, t.trialEndsAt),
		index("finance_subscriptions_mailbox_idx").on(t.mailboxId),
	],
);

/** The document ledger: one invoice, payment, credit note, refund or failed payment of a tracked subscription. */
export const financeCharges = sqliteTable(
	"finance_charges",
	{
		id: text("id").primaryKey(),
		subscriptionId: text("subscription_id")
			.notNull()
			.references(() => financeSubscriptions.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		/** A reference read through the message, never a copy; no foreign key so the ledger does not depend on attachment storage. */
		attachmentId: text("attachment_id"),
		docType: text("doc_type", { enum: ["invoice", "payment", "credit", "refund", "failed_payment"] }).notNull(),
		/** Always positive; the sign comes from `docType`. */
		amountMinor: integer("amount_minor"),
		currency: text("currency"),
		documentAt: integer("document_at", { mode: "timestamp" }).notNull(),
		periodStartAt: integer("period_start_at", { mode: "timestamp" }),
		periodEndAt: integer("period_end_at", { mode: "timestamp" }),
		/** Reserved for filing the document into Drive; always null until then. */
		filedRef: text("filed_ref"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("finance_charges_dedupe_idx").on(t.subscriptionId, t.messageId, t.docType),
		index("finance_charges_user_idx").on(t.userId, t.documentAt),
	],
);
