import { createLogger } from "@/lib/logger.mjs";
import { claimKick, writeOutbox } from "./two-way-outbox";
import { loadChangeTargets, twoWayReady } from "./two-way-store";
import type { KiteChange } from "./two-way-types";
import { planOutbox, WRITEBACK_DELAY_SECONDS, WRITEBACK_KICK_MS } from "./two-way-utils";
import { externalWritebackMessage } from "./sync-utils";

const logger = createLogger("external-sync");

/**
 * A user just did this to these messages in Kite (spec §6.8). The only way anything reaches the outbox: called from
 * the paths a person acts through, never from mailbox rules, the spam filter, the Screener or retention, so what Kite
 * does by itself stays in Kite. Each caller has already checked the user's access to the mailbox, and calls this after
 * its own write. It never throws: the action happened in Kite either way, and the mail must not fail because a
 * provider setting could not be read.
 */
export async function recordKiteChange(
	env: CloudflareEnv,
	messageIds: readonly string[],
	change: KiteChange,
	now = new Date(),
): Promise<void> {
	if (!messageIds.length) return;
	try {
		if (!(await twoWayReady(env))) return;
		const plan = planOutbox(await loadChangeTargets(env, messageIds), change);
		await writeOutbox(env, plan, now);
		if (!plan.writes.length) return;
		await kickWriteback(env, new Set(plan.writes.map((row) => row.accountId)), now);
	} catch (error) {
		logger.warn("external.two_way.record_failed", {
			kind: change.kind,
			// The error's name only: a database error's message carries the SQL and its values.
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Queues a delayed write-back per account, one a minute at most; the regular check covers a kick that is lost. */
async function kickWriteback(env: CloudflareEnv, accountIds: ReadonlySet<string>, now: Date): Promise<void> {
	if (!env.AGENT_QUEUE) return;
	for (const accountId of accountIds)
		if (await claimKick(env, accountId, now, WRITEBACK_KICK_MS))
			await env.AGENT_QUEUE.send(externalWritebackMessage(accountId), { delaySeconds: WRITEBACK_DELAY_SECONDS });
}
