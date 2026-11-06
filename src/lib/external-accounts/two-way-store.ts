import type { BatchItem } from "drizzle-orm/batch";
import { and, count, desc, eq, gte, inArray, isNull, like } from "drizzle-orm";
import { getDb } from "@/db";
import { chunkArray, inJsonArray, queryInChunks } from "@/db/chunk-utils";
import { messages } from "@/db/schema";
import {
	externalAccounts,
	externalAccountFolders,
	externalAccountTwoWay,
	externalMessageRefs,
	externalProviderActions,
	externalTwoWayState,
	messageExternalAccounts,
} from "@/db/schema/external-accounts";
import { appendRecentErrors } from "./recent-errors";
import { parseExternalRawKey, type SyncFolderRole } from "./sync-utils";
import type { ProviderSupport, TwoWaySettings } from "./two-way-types";
import {
	BACKFILL_PAGE,
	flagsActionId,
	readTwoWaySettings,
	RECONCILE_WINDOW,
	type ChangeTarget,
	type FlagChange,
	type ReconcilePlan,
	type WindowRef,
} from "./two-way-utils";

type StoreEnv = Pick<CloudflareEnv, "DB">;
export type TwoWayState = typeof externalTwoWayState.$inferSelect;
export type TwoWayConfig = { settings: TwoWaySettings; state: TwoWayState | null };

/** Migrations only add tables, so once they exist the check is skipped for the rest of the isolate's life. */
const readyDatabases = new WeakSet<object>();

/** Whether migration 0093 has been applied; reads only `sqlite_master`. Every path of two-way sync asks first. */
export async function twoWayReady(env: StoreEnv): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare("SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind("external_provider_actions")
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === 1;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}

export async function readTwoWayConfig(env: StoreEnv, accountId: string): Promise<TwoWayConfig> {
	const db = getDb(env);
	const [account] = await db
		.select({ twoWay: externalAccountTwoWay.twoWay })
		.from(externalAccountTwoWay)
		.where(eq(externalAccountTwoWay.id, accountId))
		.limit(1);
	const [state] = await db
		.select()
		.from(externalTwoWayState)
		.where(eq(externalTwoWayState.accountId, accountId))
		.limit(1);
	return { settings: readTwoWaySettings(account?.twoWay), state: state ?? null };
}

/** The stored server answers; damaged ones read as unknown. */
export function readSupport(state: TwoWayState | null): ProviderSupport | null {
	if (!state?.support) return null;
	try {
		return JSON.parse(state.support) as ProviderSupport;
	} catch {
		return null;
	}
}

export async function updateTwoWayState(
	env: StoreEnv,
	accountId: string,
	values: Partial<typeof externalTwoWayState.$inferInsert>,
) {
	await getDb(env)
		.insert(externalTwoWayState)
		.values({ accountId, ...values })
		.onConflictDoUpdate({ target: externalTwoWayState.accountId, set: values });
}

export const saveSupport = (env: StoreEnv, accountId: string, support: ProviderSupport) =>
	updateTwoWayState(env, accountId, { support: JSON.stringify(support) });

/**
 * Saves the settings. A provider-to-Kite setting turned on needs a baseline, and one that was off left the last pass's
 * marks stale, so the next pass runs whatever the server says. A Kite-to-provider setting turned off drops what waits.
 */
export async function saveTwoWaySettings(
	env: StoreEnv,
	accountId: string,
	before: TwoWaySettings,
	settings: TwoWaySettings,
): Promise<void> {
	const db = getDb(env);
	const goneOn = settings.providerGone === "trash" && before.providerGone !== "trash";
	const flagsOn = settings.providerFlags && !before.providerFlags;
	await db
		.update(externalAccountTwoWay)
		.set({ twoWay: JSON.stringify(settings) })
		.where(eq(externalAccountTwoWay.id, accountId));
	if (goneOn || flagsOn)
		await updateTwoWayState(env, accountId, {
			...(goneOn ? { goneBaseline: true } : {}),
			...(flagsOn ? { flagsBaseline: true } : {}),
			highestModseq: null,
			gonePaused: false,
		});
	const dropped = (["trash", "archive", "spam", "flags"] as const).filter((kind) => {
		const key = { trash: "kiteDelete", archive: "kiteArchive", spam: "kiteSpam", flags: "kiteFlags" } as const;
		return before[key[kind]] !== settings[key[kind]] && (settings[key[kind]] === "nothing" || !settings[key[kind]]);
	});
	if (dropped.length)
		await db.delete(externalProviderActions).where(
			and(
				eq(externalProviderActions.accountId, accountId),
				inArray(externalProviderActions.kind, dropped),
				// A move half done goes on: stopping would leave its copy and its deleted mark behind.
				eq(externalProviderActions.step, 0),
			),
		);
}

export async function countPendingActions(env: StoreEnv, accountId: string): Promise<number> {
	const [row] = await getDb(env)
		.select({ pending: count() })
		.from(externalProviderActions)
		.where(eq(externalProviderActions.accountId, accountId));
	return row?.pending ?? 0;
}

/** The account's problems, newest first. */
export async function readRecentProblems(
	env: StoreEnv,
	accountId: string,
	limit: number,
): Promise<{ at: string; message: string }[]> {
	const [row] = await getDb(env)
		.select({ recentErrors: externalAccounts.recentErrors })
		.from(externalAccounts)
		.where(eq(externalAccounts.id, accountId))
		.limit(1);
	try {
		const list = JSON.parse(row?.recentErrors ?? "[]") as { at: string; message: string }[];
		return list.slice(-limit).reverse();
	} catch {
		return [];
	}
}

export async function noteProblems(env: StoreEnv, accountId: string, notes: readonly string[], now: Date) {
	if (!notes.length) return;
	await getDb(env)
		.update(externalAccounts)
		.set({ recentErrors: appendRecentErrors(notes, now), updatedAt: now })
		.where(eq(externalAccounts.id, accountId));
}

/** Another server or login: its UIDs mean something else, so nothing known about the old one stays usable. */
export async function clearTwoWayMapping(env: StoreEnv, accountId: string): Promise<void> {
	if (!(await twoWayReady(env))) return;
	const db = getDb(env);
	await db.delete(externalProviderActions).where(eq(externalProviderActions.accountId, accountId));
	await db.delete(externalMessageRefs).where(eq(externalMessageRefs.accountId, accountId));
	// Old raw keys name the old server's UIDs: they are never linked again.
	await updateTwoWayState(env, accountId, {
		backfilled: true,
		goneBaseline: true,
		flagsBaseline: true,
		highestModseq: null,
		uidvalidity: null,
		lowUid: 0,
		gonePaused: false,
	});
}

const refFromKey = (key: string | null) => {
	const source = key ? parseExternalRawKey(key) : null;
	// 0 is what the key says when the server named no UIDVALIDITY: such a UID identifies nothing.
	return source && source.uidValidity > 0
		? { role: source.role, uidvalidity: source.uidValidity, uid: source.uid }
		: null;
};

/**
 * Records where a delivered message sits at the provider. Also re-points a message delivery dropped as a duplicate (a
 * rebuilt folder, a message moved back into the Inbox) at its new UID, but only one this account brought in: a
 * duplicate of an imported message, or of a sent one (send-as stamps the account on it, and a Cc to yourself comes back
 * with the same Message-ID), stays outside two-way sync.
 */
export async function recordFetchedMessage(
	env: StoreEnv,
	input: { messageId: string; accountId: string; key: string; read: boolean; starred: boolean },
): Promise<void> {
	if (!(await twoWayReady(env))) return;
	const place = refFromKey(input.key);
	if (!place) return;
	const db = getDb(env);
	const [message] = await db
		.select({ id: messageExternalAccounts.id })
		.from(messageExternalAccounts)
		.where(
			and(
				eq(messageExternalAccounts.id, input.messageId),
				eq(messageExternalAccounts.externalAccountId, input.accountId),
				eq(messageExternalAccounts.direction, "inbound"),
			),
		)
		.limit(1);
	if (!message) return;
	const seen = { ...place, state: "present" as const, providerRead: input.read, providerStarred: input.starred };
	await db
		.insert(externalMessageRefs)
		.values({ messageId: input.messageId, accountId: input.accountId, ...seen })
		.onConflictDoUpdate({ target: externalMessageRefs.messageId, set: seen });
}

/** The messages behind a user's action that came from a connected account; everything else is left out. */
export async function loadChangeTargets(env: StoreEnv, messageIds: readonly string[]): Promise<ChangeTarget[]> {
	const db = getDb(env);
	const rows = await queryInChunks(messageIds, (ids) =>
		db
			.select({
				messageId: messageExternalAccounts.id,
				mailboxId: messageExternalAccounts.mailboxId,
				direction: messageExternalAccounts.direction,
				rawR2Key: messageExternalAccounts.rawR2Key,
				rfcMessageId: messageExternalAccounts.providerMessageId,
				accountId: externalAccountTwoWay.id,
				accountMailboxId: externalAccountTwoWay.mailboxId,
				twoWay: externalAccountTwoWay.twoWay,
				role: externalMessageRefs.role,
				uidvalidity: externalMessageRefs.uidvalidity,
				uid: externalMessageRefs.uid,
				state: externalMessageRefs.state,
				backfilled: externalTwoWayState.backfilled,
			})
			.from(messageExternalAccounts)
			.innerJoin(externalAccountTwoWay, eq(externalAccountTwoWay.id, messageExternalAccounts.externalAccountId))
			.leftJoin(externalMessageRefs, eq(externalMessageRefs.messageId, messageExternalAccounts.id))
			.leftJoin(externalTwoWayState, eq(externalTwoWayState.accountId, externalAccountTwoWay.id))
			.where(inArray(messageExternalAccounts.id, ids)),
	);
	return rows.map((row) => ({
		messageId: row.messageId,
		accountId: row.accountId,
		mailboxId: row.mailboxId,
		settings: readTwoWaySettings(row.twoWay),
		inAccountMailbox: row.mailboxId === row.accountMailboxId,
		rfcMessageId: row.rfcMessageId,
		place: placeOf(row),
	}));
}

/**
 * Where a message sits at the provider. With no mapping row its raw key says, but only until the old messages were
 * linked: after that a message without a row is one Kite stopped knowing (a reconnect to another login, whose UIDs mean
 * something else), and sent mail is never placed at all.
 */
function placeOf(row: {
	direction: string | null;
	state: "present" | "gone" | null;
	role: SyncFolderRole | null;
	uidvalidity: number | null;
	uid: number | null;
	rawR2Key: string | null;
	backfilled: boolean | null;
}) {
	if (row.direction !== "inbound") return null;
	if (row.state === "present") return { role: row.role!, uidvalidity: row.uidvalidity!, uid: row.uid! };
	return row.state === null && !row.backfilled ? refFromKey(row.rawR2Key) : null;
}

export function batchOf(db: ReturnType<typeof getDb>, statements: BatchItem<"sqlite">[]) {
	return statements.length ? db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) : null;
}

export const refsGone = (db: ReturnType<typeof getDb>, messageIds: readonly string[]) =>
	db
		.update(externalMessageRefs)
		.set({ state: "gone", missingSince: null })
		.where(inJsonArray(externalMessageRefs.messageId, messageIds));

type Baseline = { messageId: string; read: boolean | null; starred: boolean | null };

/** The statements that set each row's last-seen state, one per combination of values. */
export function baselineStatements(db: ReturnType<typeof getDb>, baselines: readonly Baseline[]) {
	const groups = new Map<string, string[]>();
	for (const { messageId, read, starred } of baselines) {
		const key = JSON.stringify([read, starred]);
		const group = groups.get(key);
		if (group) group.push(messageId);
		else groups.set(key, [messageId]);
	}
	return [...groups].map(([key, ids]) => {
		const [providerRead, providerStarred] = JSON.parse(key) as [boolean | null, boolean | null];
		return db
			.update(externalMessageRefs)
			.set({ providerRead, providerStarred })
			.where(inJsonArray(externalMessageRefs.messageId, ids));
	});
}

/** The name of the account's Spam folder at the provider, from its cursor. */
export async function junkFolderName(env: StoreEnv, accountId: string): Promise<string | null> {
	const [row] = await getDb(env)
		.select({ name: externalAccountFolders.name })
		.from(externalAccountFolders)
		.where(and(eq(externalAccountFolders.accountId, accountId), eq(externalAccountFolders.role, "junk")))
		.limit(1);
	return row?.name ?? null;
}

/**
 * One page of messages fetched before the mapping existed, linked from their raw keys with no last-seen state, so the
 * next pass adopts them without changing anything in Kite. True once none are left.
 */
export async function linkFetchedMessages(env: StoreEnv, accountId: string): Promise<boolean> {
	const db = getDb(env);
	const rows = await db
		.select({ id: messageExternalAccounts.id, rawR2Key: messageExternalAccounts.rawR2Key })
		.from(messageExternalAccounts)
		.leftJoin(externalMessageRefs, eq(externalMessageRefs.messageId, messageExternalAccounts.id))
		.where(
			and(
				eq(messageExternalAccounts.externalAccountId, accountId),
				like(messageExternalAccounts.rawR2Key, `external/${accountId}/%`),
				isNull(externalMessageRefs.messageId),
			),
		)
		.limit(BACKFILL_PAGE);
	for (const chunk of chunkArray(rows, 25)) {
		const statements = chunk.flatMap(({ id, rawR2Key }) => {
			const place = refFromKey(rawR2Key);
			return place
				? [
						db
							.insert(externalMessageRefs)
							.values({ messageId: id, accountId, ...place })
							.onConflictDoNothing(),
					]
				: [];
		});
		await batchOf(db, statements as BatchItem<"sqlite">[]);
	}
	return rows.length < BACKFILL_PAGE;
}

/** The newest tracked INBOX messages of the current UIDVALIDITY, at or above `lowUid`, highest UID first. */
export async function readWindow(
	env: StoreEnv,
	accountId: string,
	uidvalidity: number,
	lowUid: number,
): Promise<WindowRef[]> {
	const rows = await getDb(env)
		.select({
			messageId: externalMessageRefs.messageId,
			uid: externalMessageRefs.uid,
			providerRead: externalMessageRefs.providerRead,
			providerStarred: externalMessageRefs.providerStarred,
			missingSince: externalMessageRefs.missingSince,
		})
		.from(externalMessageRefs)
		.where(
			and(
				eq(externalMessageRefs.accountId, accountId),
				eq(externalMessageRefs.role, "inbox" satisfies SyncFolderRole),
				eq(externalMessageRefs.state, "present"),
				eq(externalMessageRefs.uidvalidity, uidvalidity),
				gte(externalMessageRefs.uid, lowUid),
			),
		)
		.orderBy(desc(externalMessageRefs.uid))
		.limit(RECONCILE_WINDOW);
	return rows.map(({ missingSince, ...row }) => ({ ...row, missing: missingSince !== null }));
}

/** The stored Message-IDs of these messages. */
export async function readRfcMessageIds(
	env: StoreEnv,
	messageIds: readonly string[],
): Promise<Map<string, string | null>> {
	const db = getDb(env);
	const rows = await queryInChunks(messageIds, (ids) =>
		db
			.select({ id: messageExternalAccounts.id, rfcMessageId: messageExternalAccounts.providerMessageId })
			.from(messageExternalAccounts)
			.where(inArray(messageExternalAccounts.id, ids)),
	);
	return new Map(rows.map((row) => [row.id, row.rfcMessageId]));
}

/** Statuses a message may be moved to Trash from by the provider: never a draft, a sent copy or a queued send. */
const TRASHABLE = ["received", "archived", "spam", "screening"];

export type KiteFlagUpdate = { messageId: string; read?: boolean; starred?: boolean };

/** One update per flag and value, in the account's mailbox only. */
function kiteFlagStatements(db: ReturnType<typeof getDb>, mailboxId: string, updates: readonly KiteFlagUpdate[]) {
	return (["read", "starred"] as const).flatMap((field) =>
		[true, false].flatMap((value) => {
			const ids = updates.filter((update) => update[field] === value).map((update) => update.messageId);
			if (!ids.length) return [];
			return [
				db
					.update(messages)
					.set({ [field]: value })
					.where(and(eq(messages.mailboxId, mailboxId), inJsonArray(messages.id, ids))),
			];
		}),
	);
}

/**
 * Applies what a pass decided, in one batch: the changes in Kite and the new last-seen state together, so nothing the
 * pass changed can be seen as a change next time, and a change never goes back out (only a user's action writes to the
 * outbox). The provider's move to Kite's Trash is a status change, never a delete.
 */
export async function applyReconcile(
	env: StoreEnv,
	input: {
		accountId: string;
		mailboxId: string;
		plan: Pick<ReconcilePlan, "baselines" | "newlyMissing" | "found" | "silentlyGone">;
		/** Confirmed absent in two sessions: to Kite's Trash. */
		gone: readonly string[];
		now: Date;
		applied: readonly FlagChange[];
		kite: readonly KiteFlagUpdate[];
		/** Flag actions the provider beat, with the fields to take out of them. */
		dropped: readonly { messageId: string; fields: readonly ("read" | "starred")[] }[];
	},
): Promise<void> {
	const db = getDb(env);
	const { accountId, mailboxId, plan, gone, now, applied, kite, dropped } = input;
	const left = [...gone, ...plan.silentlyGone];
	const baselines = [...plan.baselines, ...applied.map(({ messageId, provider }) => ({ messageId, ...provider }))];
	const statements: unknown[] = [
		...kiteFlagStatements(db, mailboxId, kite),
		...baselineStatements(db, baselines),
		...(gone.length
			? [
					db
						.update(messages)
						.set({ status: "trash", folderId: null })
						.where(
							and(
								eq(messages.mailboxId, mailboxId),
								inArray(messages.status, TRASHABLE),
								inJsonArray(messages.id, gone),
							),
						),
				]
			: []),
		...(left.length ? [refsGone(db, left)] : []),
		...(plan.newlyMissing.length
			? [
					db
						.update(externalMessageRefs)
						.set({ missingSince: now })
						.where(inJsonArray(externalMessageRefs.messageId, plan.newlyMissing)),
				]
			: []),
		...(plan.found.length
			? [
					db
						.update(externalMessageRefs)
						.set({ missingSince: null })
						.where(inJsonArray(externalMessageRefs.messageId, plan.found)),
				]
			: []),
		...dropped.flatMap(({ messageId, fields }) => [
			db
				.update(externalProviderActions)
				.set(Object.fromEntries(fields.map((field) => [field, null])))
				.where(eq(externalProviderActions.id, flagsActionId(messageId))),
		]),
		...(dropped.length
			? [
					db
						.delete(externalProviderActions)
						.where(
							and(
								eq(externalProviderActions.accountId, accountId),
								eq(externalProviderActions.kind, "flags"),
								isNull(externalProviderActions.read),
								isNull(externalProviderActions.starred),
							),
						),
				]
			: []),
	];
	await batchOf(db, statements as BatchItem<"sqlite">[]);
}
