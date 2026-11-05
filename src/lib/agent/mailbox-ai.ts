import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth/types";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { getDb, type AppDatabase } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings, messages } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { MailboxAiOffError } from "./mailbox-ai-utils";

/** Before migration 0091 the switch does not exist, so no mailbox can have it on: today's behaviour is kept. */
function beforeMigration(error: unknown): boolean {
	return missingColumnFromError(error) === "ai_disabled" || isNoSuchTableError(error);
}

/**
 * The gate. Of `mailboxIds`, the ones whose "No AI for this mailbox" switch is on. Every AI path asks it: the model
 * selection (`getAgentModel`) refuses a request that carries mail of such a mailbox, and the paths that only show
 * or schedule AI work (suggestions, one-line summaries, jobs, writing style) leave such a mailbox out.
 *
 * Fails closed: an empty id throws (a caller lost track of a mailbox), and any read error other than the missing
 * column of a pending migration propagates, so the caller's AI request fails instead of running unchecked.
 */
export async function aiOffMailboxIds(
	source: CloudflareEnv | AppDatabase,
	mailboxIds: readonly string[],
): Promise<Set<string>> {
	if (mailboxIds.some((id) => typeof id !== "string" || !id)) throw new Error("A mailbox id is missing");
	const ids = [...new Set(mailboxIds)];
	if (ids.length === 0) return new Set();
	const db = "select" in source ? source : getDb(source);
	try {
		const rows = await db
			.select({ mailboxId: mailboxAgentSettings.mailboxId })
			.from(mailboxAgentSettings)
			// One JSON parameter: a list page or a user's mailboxes can pass D1's 100 bound parameters.
			.where(and(inJsonArray(mailboxAgentSettings.mailboxId, ids), eq(mailboxAgentSettings.aiDisabled, true)));
		return new Set(rows.map((row) => row.mailboxId));
	} catch (error) {
		if (beforeMigration(error)) return new Set();
		throw error;
	}
}

/** Whether AI is off for this mailbox. */
export async function mailboxAiOff(source: CloudflareEnv | AppDatabase, mailboxId: string): Promise<boolean> {
	return (await aiOffMailboxIds(source, [mailboxId])).size > 0;
}

/** Throws `MailboxAiOffError` when AI is off for this mailbox; the check before every model request. */
export async function assertMailboxAiAllowed(env: CloudflareEnv, mailboxId: string): Promise<void> {
	if (await mailboxAiOff(env, mailboxId)) throw new MailboxAiOffError();
}

/**
 * Where a record shown to the assistant came from: the mailboxes and messages its content was read from, and refs an
 * agent action may have changed (a Money Watch card from one mailbox updating a subscription found in another).
 * `null` means "none"; an empty string is a lost id and hides the record.
 */
export type AiSource = {
	mailboxIds?: readonly (string | null | undefined)[];
	messageIds?: readonly (string | null | undefined)[];
	refs?: readonly { kind: string; id: string }[];
};

const present = (value: string | null | undefined): value is string => typeof value === "string";
const refKey = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;

/** The mailbox of each message that still exists. */
async function messageMailboxes(db: AppDatabase, ids: string[]): Promise<Map<string, string | null>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId })
		.from(messages)
		.where(inJsonArray(messages.id, ids));
	return new Map(rows.map((row) => [row.id, row.mailboxId]));
}

/** Every mailbox with AI off in the install: few, so the per-record checks below start from it. */
async function allAiOffMailboxIds(db: AppDatabase): Promise<Set<string>> {
	try {
		const rows = await db
			.select({ mailboxId: mailboxAgentSettings.mailboxId })
			.from(mailboxAgentSettings)
			.where(eq(mailboxAgentSettings.aiDisabled, true));
		return new Set(rows.map((row) => row.mailboxId));
	} catch (error) {
		if (beforeMigration(error)) return new Set();
		throw error;
	}
}

/**
 * The AI-off mailboxes of applied or pending agent actions that changed each ref (the module's result names it as
 * `ref`). Only actions taken in those mailboxes are read (`agent_actions_mailbox_created_idx`), never the whole log.
 */
async function refMailboxes(db: AppDatabase, keys: string[], off: ReadonlySet<string>): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	if (keys.length === 0 || off.size === 0) return found;
	const key = sql<string>`json_extract(${agentActions.after}, '$.ref.kind') || ':' || json_extract(${agentActions.after}, '$.ref.id')`;
	try {
		const rows = await db
			.select({ key, mailboxId: agentActions.mailboxId })
			.from(agentActions)
			.where(
				and(
					inJsonArray(agentActions.mailboxId, [...off]),
					inArray(agentActions.status, ["applied", "pending"]),
					inJsonArray(key, keys),
				),
			);
		for (const row of rows) found.set(row.key, [...(found.get(row.key) ?? []), row.mailboxId]);
		return found;
	} catch (error) {
		if (isNoSuchTableError(error)) return found;
		throw error;
	}
}

const hasLostId = (source: AiSource) =>
	[...(source.mailboxIds ?? []), ...(source.messageIds ?? [])].some((id) => id === "");

/**
 * For each source, whether what it describes must stay away from the AI provider: anything read from a mailbox with
 * AI off, or changed by an action taken in one. Fails closed: an empty id, or (while any mailbox has AI off) a
 * message that cannot be found, hides the record; a read error throws. With no mailbox off nothing else is read.
 */
export async function aiHiddenSources(env: CloudflareEnv, sources: readonly AiSource[]): Promise<boolean[]> {
	if (sources.length === 0) return [];
	const db = getDb(env);
	const off = await allAiOffMailboxIds(db);
	if (off.size === 0) return sources.map(hasLostId);
	const messageIds = [...new Set(sources.flatMap((source) => (source.messageIds ?? []).filter(present)))];
	const refKeys = [...new Set(sources.flatMap((source) => (source.refs ?? []).map(refKey)))];
	const [byMessage, byRef] = await Promise.all([
		messageMailboxes(db, messageIds.filter(Boolean)),
		refMailboxes(db, refKeys, off),
	]);
	return sources.map((source) => {
		if (hasLostId(source)) return true;
		const ids = (source.mailboxIds ?? []).filter(present);
		for (const id of (source.messageIds ?? []).filter(present)) {
			const mailboxId = byMessage.get(id);
			if (mailboxId === undefined) return true;
			if (mailboxId) ids.push(mailboxId);
		}
		for (const ref of source.refs ?? []) ids.push(...(byRef.get(refKey(ref)) ?? []));
		return ids.some((id) => off.has(id));
	});
}

/**
 * When AI was last turned off for a mailbox this viewer can read, or null when none has it off. Chat history from
 * before then is not sent again: an earlier answer may quote that mailbox. The time is `ai_disabled_at` (0092), set only
 * when the switch flips; before 0092, or for a row restored without it, the mailbox's last settings save stands in,
 * which is never earlier than the switch.
 */
export async function aiOffSince(env: CloudflareEnv, viewer: Pick<SessionUser, "id" | "email" | "role">) {
	const db = getDb(env);
	const readable = await listAccessibleMailboxIds(db, viewer);
	if (readable.length === 0) return null;
	const where = and(eq(mailboxAgentSettings.aiDisabled, true), inJsonArray(mailboxAgentSettings.mailboxId, readable));
	const latest = (at: SQL) =>
		db
			.select({ at: sql<number | null>`max(${at})` })
			.from(mailboxAgentSettings)
			.where(where);
	try {
		let rows: { at: number | null }[];
		try {
			rows = await latest(sql`coalesce(${mailboxAgentSettings.aiDisabledAt}, ${mailboxAgentSettings.updatedAt})`);
		} catch (error) {
			if (missingColumnFromError(error) !== "ai_disabled_at") throw error;
			rows = await latest(sql`${mailboxAgentSettings.updatedAt}`);
		}
		return rows[0]?.at ? new Date(Number(rows[0].at) * 1000) : null;
	} catch (error) {
		if (beforeMigration(error)) return null;
		throw error;
	}
}
