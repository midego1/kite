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

/**
 * A payment document found in mail that is not a tracked subscription's (spec §25): one per owner and message.
 * `removedAt` keeps a removed row as a tombstone, so neither triage nor a scan records the message again.
 */
export const financePayments = sqliteTable(
	"finance_payments",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		/** A reference read through the message, never a copy. */
		attachmentId: text("attachment_id"),
		vendor: text("vendor").notNull(),
		vendorKey: text("vendor_key").notNull(),
		docType: text("doc_type", { enum: ["invoice", "payment", "credit", "refund"] }).notNull(),
		status: text("status", { enum: ["open", "paid", "refunded", "credited"] }).notNull(),
		/** Always positive; the sign comes from `docType`. */
		amountMinor: integer("amount_minor").notNull(),
		currency: text("currency").notNull(),
		documentAt: integer("document_at", { mode: "timestamp" }).notNull(),
		source: text("source", { enum: ["auto", "scan"] }).notNull(),
		/** The receipt, invoice or order number: one row per vendor, type and number. */
		docRef: text("doc_ref"),
		/** The Message-ID: one row per copy of a message delivered to several mailboxes. */
		mailRef: text("mail_ref"),
		/** JSON list of the fields the model filled. */
		modelFields: text("model_fields"),
		removedAt: integer("removed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("finance_payments_message_idx").on(t.userId, t.messageId),
		uniqueIndex("finance_payments_mail_ref_idx").on(t.userId, t.mailRef),
		uniqueIndex("finance_payments_doc_ref_idx").on(t.userId, t.vendorKey, t.docType, t.docRef),
		index("finance_payments_user_idx").on(t.userId, t.documentAt),
	],
);

/** The "Scan last 90 days" of one owner: a cursor over their mail, leased by one run at a time. */
export const financePaymentScans = sqliteTable("finance_payment_scans", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
	sinceAt: integer("since_at", { mode: "timestamp" }).notNull(),
	cursorAt: integer("cursor_at", { mode: "timestamp" }),
	cursorId: text("cursor_id"),
	scanned: integer("scanned").notNull().default(0),
	recorded: integer("recorded").notNull().default(0),
	/** Messages that could not be read twice in a row and were passed over. */
	skipped: integer("skipped").notNull().default(0),
	leaseUntil: integer("lease_until", { mode: "timestamp" }),
	startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	finishedAt: integer("finished_at", { mode: "timestamp" }),
	/** Why a stalled run was given up on (migration 0095); null while running or after a clean finish. */
	error: text("error"),
	/**
	 * When a page last actually saved progress, or the scan was last confirmed correctly waiting for Money Watch to
	 * come back on (migration 0095); null until the first one does. Never `updatedAt`, which a lease pickup alone
	 * also bumps: this is what tells a scan that keeps being leased and crashing, or a stalled one restarted with
	 * Try again, from one making real progress. The later of this and `startedAt` is a run's own clock.
	 */
	progressAt: integer("progress_at", { mode: "timestamp" }),
});

/**
 * "Keep receipts" (docs/specs/money-watch.md "Keep receipts"): one row per `finance_subscriptions`,
 * `finance_charges` or `finance_payments` row whose mail was copied into the owner's Drive under
 * `Money Watch/Receipts/<year>/`, so the finance row keeps working after the mail is purged or deleted
 * forever. `source_table` and `source_id` point at that row without a foreign key, since the three
 * source tables differ. A row is inserted `pending` (the claim, made before Drive is ever called) and
 * then updated to `done` or `skipped`, so a concurrent sweep and backfill tick, or a retry after a crash,
 * cannot file the same source twice: the claim itself, not the Drive write, is what makes filing
 * idempotent. `status = "skipped"` is a permanent skip (the message or attachment is already gone, or
 * there was never anything to file); a transient failure (Drive unavailable, quota full) leaves the row
 * `pending` so the next sweep or backfill tick retries it, taking over the claim once `lease_until` passes.
 */
export const financeReceipts = sqliteTable(
	"finance_receipts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sourceTable: text("source_table", {
			enum: ["finance_subscriptions", "finance_charges", "finance_payments"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		/** The raw mail as `.eml`, the self-contained readable HTML and PDF copies, and the receipt attachment; each a Drive file id. */
		emlFileId: text("eml_file_id"),
		htmlFileId: text("html_file_id"),
		pdfFileId: text("pdf_file_id"),
		attachmentFileId: text("attachment_file_id"),
		/** `pending` is a claim: a row written before Drive is called, so a concurrent sweep and backfill tick (or a
		 * retry after a crash) cannot file the same source twice. `leaseUntil` bounds how long a claim stands before
		 * another run may take it over (the same shape as `finance_payment_scans.lease_until`). */
		status: text("status", { enum: ["pending", "done", "skipped"] }).notNull(),
		skippedReason: text("skipped_reason"),
		leaseUntil: integer("lease_until", { mode: "timestamp" }),
		filedAt: integer("filed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("finance_receipts_source_idx").on(t.sourceTable, t.sourceId),
		index("finance_receipts_user_idx").on(t.userId, t.createdAt),
	],
);

/** Per-user "Keep receipts" switch (spec default: on). A missing row means on. */
export const financeReceiptSettings = sqliteTable("finance_receipt_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * "Save receipts for existing payments": one resumable backfill per owner, leased by one run at a time
 * like `finance_payment_scans`. It needs no cursor of its own: each run asks `receiptCandidates` for the
 * owner's next unfiled rows, and filing one is what moves it out of that set, so the backfill is simply
 * "keep running batches until none are left".
 */
export const financeReceiptBackfills = sqliteTable("finance_receipt_backfills", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
	scanned: integer("scanned").notNull().default(0),
	filed: integer("filed").notNull().default(0),
	skipped: integer("skipped").notNull().default(0),
	leaseUntil: integer("lease_until", { mode: "timestamp" }),
	startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	finishedAt: integer("finished_at", { mode: "timestamp" }),
});
