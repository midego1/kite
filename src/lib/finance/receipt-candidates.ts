import { and, asc, eq, exists, gt, gte, isNotNull, isNull, not, notExists, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { mailboxAgentSettings, messages, users } from "@/db/schema";
import {
	financeCharges,
	financePayments,
	financeReceipts,
	financeReceiptSettings,
	financeSubscriptions,
} from "@/db/schema/finance";
import { moduleSettings, userModuleAccess } from "@/db/schema/modules";
import { getEnv } from "@/lib/cloudflare";
import { onReceiptTables } from "./receipt-tables";

export type ReceiptSourceTable = "finance_charges" | "finance_payments" | "finance_subscriptions";

export type ReceiptCandidate = {
	sourceTable: ReceiptSourceTable;
	sourceId: string;
	userId: string;
	mailboxId: string | null;
	messageId: string;
	attachmentId: string | null;
	vendor: string;
	docType: string | null;
	documentAt: Date;
	createdAt: Date;
};

const db = () => getDb(getEnv());

/** A `finance_receipts` row for this source that is already claimed-or-filed: `done`, `skipped`, or `pending`
 * with a lease that has not yet expired. Anything else (no row, or a `pending` claim whose run died) is still
 * a candidate. */
function claimedOrDone(table: ReceiptSourceTable, idColumn: SQLiteColumn, now: Date): SQL {
	return exists(
		db()
			.select({ one: sql`1` })
			.from(financeReceipts)
			.where(
				and(
					eq(financeReceipts.sourceTable, table),
					eq(financeReceipts.sourceId, idColumn),
					or(
						sql`${financeReceipts.status} != 'pending'`,
						and(isNotNull(financeReceipts.leaseUntil), gt(financeReceipts.leaseUntil, now)),
					),
				),
			),
	);
}

/** Whether this owner is the primary admin, who `isModuleEnabledFor` (`src/lib/modules/state.ts`) always treats
 * as allowed, whatever a stale `user_module_access` row says. `ownerEligible` mirrors that here so such a row
 * does not silently exclude the primary admin's own receipts from the candidate pool. */
function isPrimaryAdminOwner(userIdColumn: SQLiteColumn): SQL {
	return exists(
		db()
			.select({ one: sql`1` })
			.from(users)
			.where(and(eq(users.id, userIdColumn), eq(users.role, "admin"), eq(users.isPrimaryAdmin, true))),
	);
}

/** Not excluded by a per-user `user_module_access` row for `moduleId`, unless the owner is the primary admin,
 * who such a row never actually blocks. */
function userModuleAllowed(userIdColumn: SQLiteColumn, moduleId: "drive" | "finance"): SQL {
	return or(
		isPrimaryAdminOwner(userIdColumn),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(userModuleAccess)
				.where(
					and(
						eq(userModuleAccess.userId, userIdColumn),
						eq(userModuleAccess.moduleId, moduleId),
						eq(userModuleAccess.allowed, false),
					),
				),
		),
	)!;
}

/** A row this feature's own setting, or the install's or the user's module state, already rules out: left out of
 * both the sweep and the backfill, so neither gets stuck offering a row that can never be filed for this owner.
 * `fileOneReceipt` checks the same things again before calling Drive (the authoritative gate); this is only what
 * keeps the candidate queries themselves from stalling on an owner who can never be filed for right now. */
function ownerEligible(userIdColumn: SQLiteColumn): SQL {
	return and(
		notExists(
			db()
				.select({ one: sql`1` })
				.from(financeReceiptSettings)
				.where(and(eq(financeReceiptSettings.userId, userIdColumn), eq(financeReceiptSettings.enabled, false))),
		),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(moduleSettings)
				.where(and(eq(moduleSettings.moduleId, "drive"), eq(moduleSettings.enabled, false))),
		),
		userModuleAllowed(userIdColumn, "drive"),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(moduleSettings)
				.where(and(eq(moduleSettings.moduleId, "finance"), eq(moduleSettings.enabled, false))),
		),
		userModuleAllowed(userIdColumn, "finance"),
	)!;
}

/** The source message's mailbox with "No AI for this mailbox" on (not the finance row's own `mailbox_id`, which can differ
 * from where the mail actually sits): Money Watch's own rule is that such a mailbox is never sent to an
 * AI provider or copied out by an automatic feature, so it is left out of the candidate pool entirely rather than
 * claimed and immediately skipped on every tick. */
function mailboxAiOn(mailboxIdColumn: SQLiteColumn): SQL {
	return notExists(
		db()
			.select({ one: sql`1` })
			.from(mailboxAgentSettings)
			.where(and(eq(mailboxAgentSettings.mailboxId, mailboxIdColumn), eq(mailboxAgentSettings.aiDisabled, true))),
	);
}

/** Unfiled, eligible `finance_charges` rows (a message and a subscription vendor, newest filings last). */
async function chargeCandidates(limit: number, userId?: string, createdAfter?: Date): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select({
				id: financeCharges.id,
				userId: financeCharges.userId,
				messageId: financeCharges.messageId,
				attachmentId: financeCharges.attachmentId,
				docType: financeCharges.docType,
				documentAt: financeCharges.documentAt,
				createdAt: financeCharges.createdAt,
				mailboxId: messages.mailboxId,
				vendor: financeSubscriptions.vendor,
			})
			.from(financeCharges)
			.innerJoin(financeSubscriptions, eq(financeSubscriptions.id, financeCharges.subscriptionId))
			.leftJoin(messages, eq(messages.id, financeCharges.messageId))
			.where(
				and(
					isNotNull(financeCharges.messageId),
					userId ? eq(financeCharges.userId, userId) : undefined,
					createdAfter ? gte(financeCharges.createdAt, createdAfter) : undefined,
					ownerEligible(financeCharges.userId),
					mailboxAiOn(messages.mailboxId),
					not(claimedOrDone("finance_charges", financeCharges.id, now)),
				),
			)
			.orderBy(asc(financeCharges.createdAt), asc(financeCharges.id))
			.limit(limit),
	);
	return rows
		.filter((row) => row.messageId)
		.map((row) => ({
			sourceTable: "finance_charges" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: row.mailboxId ?? null,
			messageId: row.messageId!,
			attachmentId: row.attachmentId,
			vendor: row.vendor,
			docType: row.docType,
			documentAt: row.documentAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled, eligible `finance_payments` rows (not a removed tombstone). */
async function paymentCandidates(limit: number, userId?: string, createdAfter?: Date): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select({ row: financePayments, messageMailboxId: messages.mailboxId })
			.from(financePayments)
			.leftJoin(messages, eq(messages.id, financePayments.messageId))
			.where(
				and(
					isNull(financePayments.removedAt),
					isNotNull(financePayments.messageId),
					userId ? eq(financePayments.userId, userId) : undefined,
					createdAfter ? gte(financePayments.createdAt, createdAfter) : undefined,
					ownerEligible(financePayments.userId),
					mailboxAiOn(messages.mailboxId),
					not(claimedOrDone("finance_payments", financePayments.id, now)),
				),
			)
			.orderBy(asc(financePayments.createdAt), asc(financePayments.id))
			.limit(limit),
	);
	return rows
		.filter(({ row }) => row.messageId)
		.map(({ row, messageMailboxId }) => ({
			sourceTable: "finance_payments" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: messageMailboxId ?? row.mailboxId,
			messageId: row.messageId!,
			attachmentId: row.attachmentId,
			vendor: row.vendor,
			docType: row.docType,
			documentAt: row.documentAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled, eligible `finance_subscriptions` rows: the message that started tracking it, if any. */
async function subscriptionCandidates(
	limit: number,
	userId?: string,
	createdAfter?: Date,
): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select({ row: financeSubscriptions, messageMailboxId: messages.mailboxId })
			.from(financeSubscriptions)
			.leftJoin(messages, eq(messages.id, financeSubscriptions.sourceMessageId))
			.where(
				and(
					isNotNull(financeSubscriptions.sourceMessageId),
					userId ? eq(financeSubscriptions.userId, userId) : undefined,
					createdAfter ? gte(financeSubscriptions.createdAt, createdAfter) : undefined,
					ownerEligible(financeSubscriptions.userId),
					mailboxAiOn(messages.mailboxId),
					not(claimedOrDone("finance_subscriptions", financeSubscriptions.id, now)),
				),
			)
			.orderBy(asc(financeSubscriptions.createdAt), asc(financeSubscriptions.id))
			.limit(limit),
	);
	return rows
		.filter(({ row }) => row.sourceMessageId)
		.map(({ row, messageMailboxId }) => ({
			sourceTable: "finance_subscriptions" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: messageMailboxId ?? row.mailboxId,
			messageId: row.sourceMessageId!,
			attachmentId: null,
			vendor: row.vendor,
			docType: null,
			documentAt: row.createdAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled rows across all three tables for one owner, oldest first. */
async function ownerReceiptCandidates(limit: number, userId: string, createdAfter?: Date): Promise<ReceiptCandidate[]> {
	const [charges, payments, subscriptions] = await Promise.all([
		chargeCandidates(limit, userId, createdAfter),
		paymentCandidates(limit, userId, createdAfter),
		subscriptionCandidates(limit, userId, createdAfter),
	]);
	return [...charges, ...payments, ...subscriptions]
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.slice(0, limit);
}

/** At most this many of one owner's rows count toward a single sweep tick: an owner whose rows keep failing
 * transiently (a full quota, say) still has, by far, the oldest rows once enough of them pile up, so without a
 * cap a tick's whole row budget would go to them, tick after tick, until their backoff eventually spaces every
 * one of their own rows out past this tick's ones — hours, with enough stuck rows (`docs/specs/money-watch.md`
 * §26.2). This is checked only for the sweep (every owner at once); the explicit backfill fetches one owner's
 * own rows directly and has nobody else's turn to protect. */
const MAX_CANDIDATES_PER_OWNER_PER_TICK = 5;
/** How many distinct owners with at least one eligible row the sweep looks at per tick, a little above what
 * filling one tick at the per-owner cap would need, so a tick's budget can still be spread across more owners
 * than that when each has few rows of their own. */
const MAX_OWNERS_PER_TICK = 20;

/** The distinct owners with at least one row no table's own filters already rule out, across all three tables,
 * each capped independently (an owner with eligible rows in two tables still counts once). Finding owners
 * first, rather than fetching a single oldest-first page across everyone and hoping it is diverse enough, is
 * what keeps one owner's pile of stuck rows (always the oldest, once enough of them exist) from pushing every
 * other owner's rows out of the page before `receiptCandidates` ever sees them. */
async function eligibleOwnerIds(limit: number, createdAfter?: Date): Promise<string[]> {
	const now = new Date();
	const [chargeOwners, paymentOwners, subscriptionOwners] = await Promise.all([
		onReceiptTables(() =>
			db()
				.selectDistinct({ userId: financeCharges.userId })
				.from(financeCharges)
				.innerJoin(financeSubscriptions, eq(financeSubscriptions.id, financeCharges.subscriptionId))
				.leftJoin(messages, eq(messages.id, financeCharges.messageId))
				.where(
					and(
						isNotNull(financeCharges.messageId),
						createdAfter ? gte(financeCharges.createdAt, createdAfter) : undefined,
						ownerEligible(financeCharges.userId),
						mailboxAiOn(messages.mailboxId),
						not(claimedOrDone("finance_charges", financeCharges.id, now)),
					),
				)
				.limit(limit),
		),
		onReceiptTables(() =>
			db()
				.selectDistinct({ userId: financePayments.userId })
				.from(financePayments)
				.leftJoin(messages, eq(messages.id, financePayments.messageId))
				.where(
					and(
						isNull(financePayments.removedAt),
						isNotNull(financePayments.messageId),
						createdAfter ? gte(financePayments.createdAt, createdAfter) : undefined,
						ownerEligible(financePayments.userId),
						mailboxAiOn(messages.mailboxId),
						not(claimedOrDone("finance_payments", financePayments.id, now)),
					),
				)
				.limit(limit),
		),
		onReceiptTables(() =>
			db()
				.selectDistinct({ userId: financeSubscriptions.userId })
				.from(financeSubscriptions)
				.leftJoin(messages, eq(messages.id, financeSubscriptions.sourceMessageId))
				.where(
					and(
						isNotNull(financeSubscriptions.sourceMessageId),
						createdAfter ? gte(financeSubscriptions.createdAt, createdAfter) : undefined,
						ownerEligible(financeSubscriptions.userId),
						mailboxAiOn(messages.mailboxId),
						not(claimedOrDone("finance_subscriptions", financeSubscriptions.id, now)),
					),
				)
				.limit(limit),
		),
	]);
	return [...new Set([...chargeOwners, ...paymentOwners, ...subscriptionOwners].map((row) => row.userId))].slice(
		0,
		limit,
	);
}

/** Unfiled rows across all three tables, oldest first, for the automatic sweep (every owner, each capped so
 * none of them can crowd the others out of this tick) or one owner's backfill (uncapped: there is nobody else
 * to protect in that owner's own run). `createdAfter`, used only by the automatic sweep (never the explicit
 * backfill, which must still reach a user's whole history), excludes a row created before the sweep floor. */
export async function receiptCandidates(
	limit: number,
	userId?: string,
	createdAfter?: Date,
): Promise<ReceiptCandidate[]> {
	if (userId) return ownerReceiptCandidates(limit, userId, createdAfter);
	const owners = await eligibleOwnerIds(MAX_OWNERS_PER_TICK, createdAfter);
	const perOwner = await Promise.all(
		owners.map((ownerId) => ownerReceiptCandidates(MAX_CANDIDATES_PER_OWNER_PER_TICK, ownerId, createdAfter)),
	);
	return perOwner
		.flat()
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.slice(0, limit);
}
