import { and, eq, inArray, sql } from "drizzle-orm";
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

/** The mailboxes of applied agent actions that changed each ref (the module's result names it as `ref`). */
async function refMailboxes(db: AppDatabase, keys: string[]): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	if (keys.length === 0) return found;
	const key = sql<string>`json_extract(${agentActions.after}, '$.ref.kind') || ':' || json_extract(${agentActions.after}, '$.ref.id')`;
	try {
		const rows = await db
			.select({ key, mailboxId: agentActions.mailboxId })
			.from(agentActions)
			.where(and(inArray(agentActions.status, ["applied", "pending"]), inJsonArray(key, keys)));
		for (const row of rows) found.set(row.key, [...(found.get(row.key) ?? []), row.mailboxId]);
		return found;
	} catch (error) {
		if (isNoSuchTableError(error)) return found;
		throw error;
	}
}

/**
 * For each source, whether what it describes must stay away from the AI provider: anything read from a mailbox with
 * AI off, or changed by an action taken in one. Fails closed: a message that cannot be found, an empty id or a read
 * error hides the record (or throws).
 */
export async function aiHiddenSources(env: CloudflareEnv, sources: readonly AiSource[]): Promise<boolean[]> {
	if (sources.length === 0) return [];
	const db = getDb(env);
	const messageIds = [...new Set(sources.flatMap((source) => (source.messageIds ?? []).filter(present)))];
	const refKeys = [...new Set(sources.flatMap((source) => (source.refs ?? []).map(refKey)))];
	const [byMessage, byRef] = await Promise.all([
		messageMailboxes(db, messageIds.filter(Boolean)),
		refMailboxes(db, refKeys),
	]);
	const resolved = sources.map((source) => {
		let lost = false;
		const ids: string[] = [];
		for (const id of (source.mailboxIds ?? []).filter(present))
			if (id) ids.push(id);
			else lost = true;
		for (const id of (source.messageIds ?? []).filter(present)) {
			const mailboxId = id ? byMessage.get(id) : undefined;
			if (mailboxId === undefined) lost = true;
			else if (mailboxId) ids.push(mailboxId);
		}
		for (const ref of source.refs ?? []) ids.push(...(byRef.get(refKey(ref)) ?? []));
		return { lost, ids };
	});
	const off = await aiOffMailboxIds(
		db,
		resolved.flatMap((entry) => entry.ids),
	);
	return resolved.map((entry) => entry.lost || entry.ids.some((id) => off.has(id)));
}

/**
 * When the most recent mailbox with AI off last had its settings saved (at or after the switch was turned on), or
 * null when no mailbox has AI off. Chat history from before then is not sent again: it may quote such a mailbox.
 */
export async function aiOffSince(env: CloudflareEnv): Promise<Date | null> {
	try {
		const [row] = await getDb(env)
			.select({ at: sql<number | null>`max(${mailboxAgentSettings.updatedAt})` })
			.from(mailboxAgentSettings)
			.where(eq(mailboxAgentSettings.aiDisabled, true));
		return row?.at ? new Date(Number(row.at) * 1000) : null;
	} catch (error) {
		if (beforeMigration(error)) return null;
		throw error;
	}
}
