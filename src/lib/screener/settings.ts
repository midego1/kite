import { and, count, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxAliases, mailboxes, messages } from "@/db/schema";
import { screenerSenders, screenerSettings } from "@/db/schema/screener";
import { queryInChunks } from "@/db/chunk-utils";
import { newId } from "@/lib/ids";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import type { MailboxDomainAddressInput } from "@/lib/mailboxes/domain-addresses-types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { SCREENING_STATUS } from "./screener-utils";
import type {
	ScreenerDecision,
	ScreenerDecisionSource,
	ScreenerSenderEntry,
	ScreenerSettings,
	ScreenerSettingsPatch,
} from "./screener-types";

/** Thrown when a write needs the Screener tables and migration 0067 has not been applied yet. */
export class ScreenerUnavailableError extends Error {
	constructor() {
		super("Apply database migration 0067 to use the Screener");
	}
}

/** Reads fall back when the tables do not exist yet, so an install keeps working before migration 0067. */
async function orFallback<T>(read: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (isNoSuchTableError(error)) return fallback;
		throw error;
	}
}

async function orUnavailable<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new ScreenerUnavailableError();
		throw error;
	}
}

export async function isScreenerAvailable(db: AppDatabase): Promise<boolean> {
	return orFallback(async () => {
		await db.select({ id: screenerSettings.mailboxId }).from(screenerSettings).limit(1);
		return true;
	}, false);
}

/** A mailbox's Screener settings; null when it has none (off) or the tables do not exist yet. */
export async function getScreenerSettings(db: AppDatabase, mailboxId: string): Promise<ScreenerSettings | null> {
	return orFallback(async () => {
		const [row] = await db
			.select({ enabled: screenerSettings.enabled, mode: screenerSettings.mode })
			.from(screenerSettings)
			.where(eq(screenerSettings.mailboxId, mailboxId))
			.limit(1);
		return row ?? null;
	}, null);
}

export async function listScreenerSettings(
	db: AppDatabase,
	mailboxIds: readonly string[],
): Promise<Map<string, ScreenerSettings>> {
	if (mailboxIds.length === 0) return new Map();
	const rows = await orFallback(
		() =>
			queryInChunks([...new Set(mailboxIds)], (chunk) =>
				db
					.select({
						mailboxId: screenerSettings.mailboxId,
						enabled: screenerSettings.enabled,
						mode: screenerSettings.mode,
					})
					.from(screenerSettings)
					.where(inArray(screenerSettings.mailboxId, chunk)),
			),
		[],
	);
	return new Map(rows.map((row) => [row.mailboxId, { enabled: row.enabled, mode: row.mode }]));
}

/** New mailboxes start with the Screener on. Before migration 0067 there is nowhere to record it, so nothing happens. */
export async function enableScreenerForNewMailbox(db: AppDatabase, mailboxId: string): Promise<void> {
	await orFallback(async () => {
		await db.insert(screenerSettings).values({ mailboxId, enabled: true, mode: "screener" }).onConflictDoNothing();
	}, undefined);
}

export async function saveScreenerSettings(
	db: AppDatabase,
	mailboxId: string,
	patch: ScreenerSettingsPatch,
	userId: string,
): Promise<ScreenerSettings> {
	return orUnavailable(async () => {
		const now = new Date();
		const [row] = await db
			.insert(screenerSettings)
			.values({
				mailboxId,
				enabled: patch.enabled ?? false,
				mode: patch.mode ?? "screener",
				updatedByUserId: userId,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: screenerSettings.mailboxId,
				set: {
					...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
					...(patch.mode !== undefined ? { mode: patch.mode } : {}),
					updatedByUserId: userId,
					updatedAt: now,
				},
			})
			.returning({ enabled: screenerSettings.enabled, mode: screenerSettings.mode });
		return row;
	});
}

export async function getSenderDecision(
	db: AppDatabase,
	mailboxId: string,
	address: string,
): Promise<ScreenerDecision | null> {
	return orFallback(async () => {
		const [row] = await db
			.select({ decision: screenerSenders.decision })
			.from(screenerSenders)
			.where(and(eq(screenerSenders.mailboxId, mailboxId), eq(screenerSenders.address, address)))
			.limit(1);
		return row?.decision ?? null;
	}, null);
}

/** Which of `addresses` already have a decision in each mailbox, keyed `mailboxId` then address. */
export async function listDecidedAddresses(
	db: AppDatabase,
	mailboxIds: readonly string[],
	addresses: readonly string[],
): Promise<Map<string, Set<string>>> {
	const result = new Map<string, Set<string>>();
	if (mailboxIds.length === 0 || addresses.length === 0) return result;
	const rows = await orFallback(
		() =>
			queryInChunks([...new Set(addresses)], (chunk) =>
				db
					.select({ mailboxId: screenerSenders.mailboxId, address: screenerSenders.address })
					.from(screenerSenders)
					.where(and(inArray(screenerSenders.mailboxId, [...mailboxIds]), inArray(screenerSenders.address, chunk))),
			),
		[],
	);
	for (const row of rows) {
		const set = result.get(row.mailboxId) ?? new Set<string>();
		set.add(row.address);
		result.set(row.mailboxId, set);
	}
	return result;
}

export async function listScreenerSenders(db: AppDatabase, mailboxId: string): Promise<ScreenerSenderEntry[]> {
	const rows = await orFallback(
		() =>
			db
				.select({
					address: screenerSenders.address,
					decision: screenerSenders.decision,
					source: screenerSenders.source,
					createdAt: screenerSenders.createdAt,
				})
				.from(screenerSenders)
				.where(eq(screenerSenders.mailboxId, mailboxId))
				.orderBy(screenerSenders.address),
		[],
	);
	return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** Records a decision, replacing an earlier one for the same address. */
export async function recordSenderDecision(
	db: AppDatabase,
	input: {
		mailboxId: string;
		address: string;
		decision: ScreenerDecision;
		source: ScreenerDecisionSource;
		userId: string | null;
	},
): Promise<void> {
	await orUnavailable(async () => {
		const now = new Date();
		await db
			.insert(screenerSenders)
			.values({
				id: newId("scr"),
				mailboxId: input.mailboxId,
				address: input.address,
				decision: input.decision,
				source: input.source,
				decidedByUserId: input.userId,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [screenerSenders.mailboxId, screenerSenders.address],
				set: { decision: input.decision, source: input.source, decidedByUserId: input.userId, updatedAt: now },
			});
	});
}

/** Approves addresses that have no decision yet; returns the ones it approved. Denied senders stay denied. */
export async function approveUndecidedAddresses(
	db: AppDatabase,
	mailboxId: string,
	addresses: readonly string[],
	source: ScreenerDecisionSource,
	userId: string | null,
): Promise<string[]> {
	if (addresses.length === 0) return [];
	const decided = (await listDecidedAddresses(db, [mailboxId], addresses)).get(mailboxId) ?? new Set<string>();
	const fresh = [...new Set(addresses)].filter((address) => !decided.has(address));
	if (fresh.length === 0) return [];
	const now = new Date();
	await orUnavailable(() =>
		queryInChunks(
			fresh,
			(chunk) =>
				db
					.insert(screenerSenders)
					.values(
						chunk.map((address) => ({
							id: newId("scr"),
							mailboxId,
							address,
							decision: "approved" as const,
							source,
							decidedByUserId: userId,
							createdAt: now,
							updatedAt: now,
						})),
					)
					.onConflictDoNothing()
					.returning({ address: screenerSenders.address }),
			// Eight bound values per row, under D1's limit of 100 per statement.
			10,
		),
	);
	return fresh;
}

export async function deleteSenderDecision(
	db: AppDatabase,
	mailboxId: string,
	address: string,
): Promise<ScreenerDecision | null> {
	return orUnavailable(async () => {
		const [row] = await db
			.delete(screenerSenders)
			.where(and(eq(screenerSenders.mailboxId, mailboxId), eq(screenerSenders.address, address)))
			.returning({ decision: screenerSenders.decision });
		return row?.decision ?? null;
	});
}

export async function countScreenedMessages(db: AppDatabase, mailboxId: string): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.status, SCREENING_STATUS)));
	return row?.total ?? 0;
}

/** Every address of every mailbox and alias on this install, plus the extra domain addresses of `mailbox`. */
export async function screenerOwnAddresses(
	db: AppDatabase,
	mailbox?: MailboxDomainAddressInput | null,
): Promise<Set<string>> {
	const [primary, aliases, extra] = await Promise.all([
		db
			.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id)),
		db
			.select({ localPart: mailboxAliases.localPart, hostname: domains.hostname })
			.from(mailboxAliases)
			.innerJoin(domains, eq(mailboxAliases.domainId, domains.id)),
		mailbox ? getMailboxDomainAddresses(db, mailbox) : Promise.resolve([]),
	]);
	return new Set([
		...[...primary, ...aliases].map((row) => `${row.localPart}@${row.hostname}`.toLowerCase()),
		...extra,
	]);
}
