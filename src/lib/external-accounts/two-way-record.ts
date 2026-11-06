import { getDb } from "@/db";
import type { SessionUser } from "@/lib/auth/types";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { claimKick, writeOutbox } from "./two-way-outbox";
import { loadChangeTargets, twoWayReady } from "./two-way-store";
import type { KiteChange } from "./two-way-types";
import {
	kiteMove,
	planOutbox,
	WRITEBACK_KICK_DELAY_SECONDS,
	WRITEBACK_KICK_MS,
	writesToProvider,
	type ChangeTarget,
} from "./two-way-utils";
import { externalWritebackMessage } from "./sync-utils";

const logger = createLogger("external-sync");

type Actor = Pick<SessionUser, "id" | "role">;

/**
 * Keeps the messages this person may carry to the provider: full access to the mailbox, read and star included. Someone
 * with read access changes Kite only, because the provider's copy belongs to the account's owner.
 */
async function withFullAccess(env: CloudflareEnv, actor: Actor, targets: readonly ChangeTarget[]) {
	const db = getDb(env);
	const access = new Map<string, boolean>();
	const allowed: ChangeTarget[] = [];
	for (const target of targets) {
		const mailboxId = target.mailboxId;
		if (!mailboxId || !writesToProvider(target.settings)) continue;
		if (!access.has(mailboxId)) access.set(mailboxId, !!(await getMailboxAccessLevel(db, actor, mailboxId))?.canManage);
		if (access.get(mailboxId)) allowed.push(target);
	}
	return allowed;
}

async function record(env: CloudflareEnv, messageIds: readonly string[], change: KiteChange, actor: Actor | null) {
	if (!messageIds.length) return;
	const now = new Date();
	try {
		if (!(await twoWayReady(env))) return;
		const targets = await loadChangeTargets(env, messageIds);
		const plan = planOutbox(actor ? await withFullAccess(env, actor, targets) : targets, change);
		await writeOutbox(env, plan, now);
		if (plan.writes.length) await kickWriteback(env, new Set(plan.writes.map((row) => row.accountId)), now);
	} catch (error) {
		logger.warn("external.two_way.record_failed", {
			kind: change.kind,
			// The error's name only: a database error's message carries the SQL and its values.
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/**
 * A user just did this to these messages in Kite (spec §6.8). The only way anything reaches the outbox: called from
 * the paths a person acts through, never from mailbox rules, the spam filter, the Screener or retention, so what Kite
 * does by itself stays in Kite. Calling it comes after the caller's own write and its own access check. It never
 * throws: the action happened in Kite either way, and the mail must not fail because a provider setting could not be
 * read.
 */
export function recordKiteChange(
	env: CloudflareEnv,
	actor: Actor,
	messageIds: readonly string[],
	change: KiteChange,
): Promise<void> {
	return record(env, messageIds, change, actor);
}

/** An undo: takes back the moves that still wait for these messages, and writes nothing. */
export function cancelKiteMoves(env: CloudflareEnv, messageIds: readonly string[]): Promise<void> {
	return record(env, messageIds, { kind: "other" }, null);
}

/**
 * A person deleting these messages, wherever they were. A delete out of Kite's Spam reaches the provider only for mail
 * that came from the provider's Spam folder: what Kite's own filter put there is still in the provider's Inbox, and
 * throwing away Kite's verdict says nothing about the provider's copy.
 */
export async function recordDeletes(
	env: CloudflareEnv,
	actor: Actor,
	rows: readonly { id: string; status: string }[],
): Promise<void> {
	const ids = (spam: boolean) => rows.filter((row) => (row.status === "spam") === spam).map((row) => row.id);
	await record(env, ids(false), { kind: "trash" }, actor);
	await record(env, ids(true), { kind: "trash", junkOnly: true }, actor);
}

/** A person moving one message from `status` to another status. */
export function recordMove(
	env: CloudflareEnv,
	actor: Actor,
	message: { id: string; status: string },
	next: string,
): Promise<void> {
	if (next === "trash") return recordDeletes(env, actor, [message]);
	return record(env, [message.id], kiteMove(next), actor);
}

/** Queues a delayed write-back per account, one a minute at most; the regular check covers a kick that is lost. */
async function kickWriteback(env: CloudflareEnv, accountIds: ReadonlySet<string>, now: Date): Promise<void> {
	if (!env.AGENT_QUEUE) return;
	for (const accountId of accountIds)
		if (await claimKick(env, accountId, now, WRITEBACK_KICK_MS))
			await env.AGENT_QUEUE.send(externalWritebackMessage(accountId), { delaySeconds: WRITEBACK_KICK_DELAY_SECONDS });
}
