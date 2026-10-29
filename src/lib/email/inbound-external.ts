import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { deliverInboundMessage, recoverAgentWork, storedFromRaw } from "@/lib/email/inbound-deliver";
import { completeRawHeaderValues, parseRawHeaders } from "@/lib/email/raw-headers";
import { externalAccountTablesReady } from "@/lib/external-accounts/errors";
import { findPreset } from "@/lib/external-accounts/presets-utils";
import { appendRecentError } from "@/lib/external-accounts/serialize-utils";
import { externalSyncRefusal } from "@/lib/external-accounts/sync-target";
import { createLogger } from "@/lib/logger.mjs";
import { externalAuthenticationResults } from "@/lib/spam/authentication-results-utils";
import type { InboundQueueMessage, InboundQueueSource } from "@/lib/email/inbound";

const logger = createLogger("external-sync");

/**
 * The resolve half of the inbound pipeline for mail a connected account synced (spec §6.4). The destination is the
 * account's mailbox, while the account exists, its owner may still use connected accounts and still has full access
 * to that mailbox; domain routing, reject rules and account forwarding belong to Kite's own domains and do not apply.
 * A message that cannot be delivered is removed from the Mail store. Then it is delivered exactly as received mail is,
 * with a Message-ID check against the mailbox first.
 */
export async function processExternalInbound(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	source: InboundQueueSource,
): Promise<void> {
	const key = payload.rawR2Key;
	if (!(await externalAccountTablesReady(env))) return;
	const db = getDb(env);
	const [account] = await db
		.select({
			id: externalAccounts.id,
			userId: externalAccounts.userId,
			mailboxId: externalAccounts.mailboxId,
			address: externalAccounts.address,
			preset: externalAccounts.preset,
			trustAuthResults: externalAccounts.trustAuthResults,
			recentErrors: externalAccounts.recentErrors,
		})
		.from(externalAccounts)
		.where(eq(externalAccounts.id, source.accountId))
		.limit(1);
	if (!account) {
		// Removed after the message was fetched: nothing receives it any more (spec §6.7).
		await env.BUCKET.delete(key);
		return;
	}
	const target = { mailboxId: account.mailboxId, userId: account.userId };
	const stored = await storedFromRaw(env, target.mailboxId, key);
	if (stored) {
		await recoverAgentWork(env, target, stored, undefined);
		return;
	}
	const refusal = await externalSyncRefusal(env, account);
	if (refusal) {
		logger.warn("external.sync.dropped", { accountId: account.id, reason: refusal });
		await env.BUCKET.delete(key);
		return;
	}
	const object = await env.BUCKET.get(key);
	if (!object) {
		console.error(`Missing R2 object: ${key}`);
		return;
	}
	const raw = await object.arrayBuffer();
	const authservId = account.trustAuthResults ? (findPreset(account.preset)?.authservId ?? null) : null;
	const outcome = await deliverInboundMessage(env, {
		target,
		from: payload.from,
		to: account.address,
		rawR2Key: key,
		raw,
		deliveredAddress: account.address,
		headers: Object.fromEntries([...parseRawHeaders(raw)].map(([name, values]) => [name, values[0] ?? ""])),
		authenticationResults: externalAuthenticationResults(
			completeRawHeaderValues(raw, "authentication-results"),
			authservId,
		),
		external: { accountId: account.id, read: source.read === true, starred: source.starred === true },
	});
	if (!outcome.delivered && outcome.reason === "attachment_limit") {
		const now = new Date();
		await db
			.update(externalAccounts)
			.set({
				recentErrors: appendRecentError(account.recentErrors, `Kite did not deliver a message: ${outcome.detail}`, now),
				updatedAt: now,
			})
			.where(eq(externalAccounts.id, account.id));
	}
}
