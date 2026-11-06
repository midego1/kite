import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chunkArray, inJsonArray } from "@/db/chunk-utils";
import { externalMessageRefs, externalProviderActions, externalTwoWayState } from "@/db/schema/external-accounts";
import { baselineStatements, batchOf, refsGone } from "./two-way-store";
import { isLastAttempt, writebackRetryMs, type OutboxPlan, type OutboxRow, type PendingFlags } from "./two-way-utils";

/**
 * The outbox of two-way sync (spec §6.8): written when a user acts, read and finished by the write-back. Finishing a
 * row and recording what it changed at the provider are one batch, which is what keeps a change from coming back.
 */

type StoreEnv = Pick<CloudflareEnv, "DB">;

/**
 * Writes an action's outbox rows; a row replaces what waits under its id and the newest action sets its time. A message
 * acted on before the mapping knew it gets its mapping row here too, so the run that follows has a row to finish.
 */
export async function writeOutbox(env: StoreEnv, plan: OutboxPlan, now: Date): Promise<void> {
	const db = getDb(env);
	if (plan.cancels.length)
		await db.delete(externalProviderActions).where(inJsonArray(externalProviderActions.id, plan.cancels));
	for (const chunk of chunkArray(plan.writes, 25)) {
		const statements = chunk.flatMap((row) => [
			db
				.insert(externalMessageRefs)
				.values({
					messageId: row.messageId,
					accountId: row.accountId,
					role: row.role,
					uidvalidity: row.uidvalidity,
					uid: row.uid,
				})
				.onConflictDoNothing(),
			db
				.insert(externalProviderActions)
				.values({ ...row, createdAt: now, nextAttemptAt: now })
				.onConflictDoUpdate({
					target: externalProviderActions.id,
					set: {
						kind: row.kind,
						// A flag this action does not touch keeps what still waits for it.
						read: sql`coalesce(excluded.read, ${externalProviderActions.read})`,
						starred: sql`coalesce(excluded.starred, ${externalProviderActions.starred})`,
						createdAt: now,
						attempts: 0,
						nextAttemptAt: now,
					},
				}),
		]);
		await db.batch(statements as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
	}
}

/** True for the one caller allowed to queue a run now; the rest of a burst is covered by it. */
export async function claimKick(env: StoreEnv, accountId: string, now: Date, windowMs: number): Promise<boolean> {
	const db = getDb(env);
	await db.insert(externalTwoWayState).values({ accountId }).onConflictDoNothing();
	const claimed = await db
		.update(externalTwoWayState)
		.set({ kickedAt: now })
		.where(
			and(
				eq(externalTwoWayState.accountId, accountId),
				or(isNull(externalTwoWayState.kickedAt), lt(externalTwoWayState.kickedAt, new Date(now.getTime() - windowMs))),
			),
		)
		.returning({ accountId: externalTwoWayState.accountId });
	return claimed.length > 0;
}

export async function readDueActions(env: StoreEnv, accountId: string, now: Date, limit: number): Promise<OutboxRow[]> {
	return getDb(env)
		.select({
			id: externalProviderActions.id,
			accountId: externalProviderActions.accountId,
			messageId: externalProviderActions.messageId,
			kind: externalProviderActions.kind,
			read: externalProviderActions.read,
			starred: externalProviderActions.starred,
			role: externalProviderActions.role,
			uidvalidity: externalProviderActions.uidvalidity,
			uid: externalProviderActions.uid,
			rfcMessageId: externalProviderActions.rfcMessageId,
			createdAt: externalProviderActions.createdAt,
			attempts: externalProviderActions.attempts,
			providerRead: externalMessageRefs.providerRead,
			providerStarred: externalMessageRefs.providerStarred,
		})
		.from(externalProviderActions)
		.leftJoin(externalMessageRefs, eq(externalMessageRefs.messageId, externalProviderActions.messageId))
		.where(
			and(
				eq(externalProviderActions.accountId, accountId),
				sql`${externalProviderActions.nextAttemptAt} <= ${Math.floor(now.getTime() / 1000)}`,
			),
		)
		.orderBy(asc(externalProviderActions.createdAt))
		.limit(limit);
}

/** What waits for this account, as a pass needs it: which messages are moving, and the flag actions by message. */
export async function readPendingActions(
	env: StoreEnv,
	accountId: string,
): Promise<{ moves: Set<string>; flags: Map<string, PendingFlags> }> {
	const rows = await getDb(env)
		.select({
			messageId: externalProviderActions.messageId,
			kind: externalProviderActions.kind,
			read: externalProviderActions.read,
			starred: externalProviderActions.starred,
			createdAt: externalProviderActions.createdAt,
		})
		.from(externalProviderActions)
		.where(eq(externalProviderActions.accountId, accountId));
	const moves = new Set<string>();
	const flags = new Map<string, PendingFlags>();
	for (const { messageId, kind, ...rest } of rows)
		if (kind === "flags") flags.set(messageId, rest);
		else moves.add(messageId);
	return { moves, flags };
}

export async function deleteActions(env: StoreEnv, ids: readonly string[]): Promise<void> {
	const db = getDb(env);
	if (ids.length) await db.delete(externalProviderActions).where(inJsonArray(externalProviderActions.id, ids));
}

/**
 * Rows that are finished because their message left the folder: deleted together with marking the mapping `gone`, so a
 * move Kite made can never come back as a disappearance from the provider.
 */
export async function finishMoved(env: StoreEnv, rows: readonly OutboxRow[]): Promise<void> {
	if (!rows.length) return;
	const db = getDb(env);
	await batchOf(db, [
		refsGone(
			db,
			rows.map((row) => row.messageId),
		),
		db.delete(externalProviderActions).where(
			inJsonArray(
				externalProviderActions.id,
				rows.map((row) => row.id),
			),
		),
	] as BatchItem<"sqlite">[]);
}

/**
 * Flag rows that went through: deleted together with the new last-seen state, so the change Kite made is not read back
 * as one from the provider.
 */
export async function finishFlags(
	env: StoreEnv,
	done: readonly { row: OutboxRow; read: boolean | null; starred: boolean | null }[],
): Promise<void> {
	if (!done.length) return;
	const db = getDb(env);
	await batchOf(db, [
		...baselineStatements(
			db,
			done.map(({ row, read, starred }) => ({ messageId: row.messageId, read, starred })),
		),
		db.delete(externalProviderActions).where(
			inJsonArray(
				externalProviderActions.id,
				done.map(({ row }) => row.id),
			),
		),
	] as BatchItem<"sqlite">[]);
}

/** Counts a failed try per row and sets its retry; a row out of tries is dropped. Returns how many were. */
export async function failActions(env: StoreEnv, rows: readonly OutboxRow[], now: Date): Promise<number> {
	const db = getDb(env);
	const lastTry = rows.filter((row) => isLastAttempt(row.attempts));
	await deleteActions(
		env,
		lastTry.map((row) => row.id),
	);
	for (const row of rows.filter((entry) => !isLastAttempt(entry.attempts)))
		await db
			.update(externalProviderActions)
			.set({
				attempts: row.attempts + 1,
				nextAttemptAt: new Date(now.getTime() + writebackRetryMs(row.attempts + 1)),
			})
			.where(eq(externalProviderActions.id, row.id));
	return lastTry.length;
}
