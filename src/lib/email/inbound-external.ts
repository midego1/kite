import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { externalAccountFolders, externalAccounts } from "@/db/schema/external-accounts";
import { deliverInboundMessage, recoverAgentWork, storedFromRaw } from "@/lib/email/inbound-deliver";
import { completeRawHeaderFields, parseRawHeaders } from "@/lib/email/raw-headers";
import { externalAccountTablesReady } from "@/lib/external-accounts/errors";
import { findPreset } from "@/lib/external-accounts/presets-utils";
import { appendRecentErrors } from "@/lib/external-accounts/recent-errors";
import { externalSyncRefusal } from "@/lib/external-accounts/sync-target";
import { createLogger } from "@/lib/logger.mjs";
import { externalAuthenticationResults } from "@/lib/spam/authentication-results-utils";
import type { InboundQueueMessage, InboundQueueSource } from "@/lib/email/inbound";

const logger = createLogger("external-sync");

/** `external/<accountId>/<uidvalidity>/<uid>.eml`, the key a sync run wrote (`externalRawKey`). */
const EXTERNAL_KEY = /^external\/[^/]+\/(\d+)\/(\d+)\.eml$/;

/**
 * Moves the account's INBOX cursor back to just before this message, so the next check fetches it again: delivery
 * refused it for now (the owner's permission or the install switch), and once that is lifted the message arrives
 * instead of being lost; dedupe drops whatever of the rest Kite already has. Only within the same UIDVALIDITY.
 */
async function rewindCursor(env: CloudflareEnv, accountId: string, key: string): Promise<void> {
	const match = EXTERNAL_KEY.exec(key);
	if (!match) return;
	const [uidValidity, uid] = [Number(match[1]), Number(match[2])];
	await getDb(env)
		.update(externalAccountFolders)
		.set({ lastUid: uid - 1 })
		.where(
			and(
				eq(externalAccountFolders.accountId, accountId),
				eq(externalAccountFolders.name, "INBOX"),
				eq(externalAccountFolders.uidvalidity, uidValidity),
				gte(externalAccountFolders.lastUid, uid),
			),
		);
}

async function noteOnAccount(env: CloudflareEnv, accountId: string, message: string): Promise<void> {
	const now = new Date();
	await getDb(env)
		.update(externalAccounts)
		.set({ recentErrors: appendRecentErrors([message], now), updatedAt: now })
		.where(eq(externalAccounts.id, accountId));
}

/**
 * The resolve half of the inbound pipeline for mail a connected account synced (spec §6.4). The destination is the
 * account's mailbox, while the account exists, its owner may still use connected accounts and still has full access
 * to that mailbox; domain routing, reject rules and account forwarding belong to Kite's own domains and do not apply.
 * The message belongs to the mailbox's owner, as received mail does. A message refused for now is removed from the
 * Mail store and the account's cursor moved back so a later check fetches it again; one whose account is gone is
 * removed. Then it is delivered exactly as received mail is, with a Message-ID check against the mailbox first.
 * `finalAttempt` says the queue will not retry this delivery again, so a failure is noted on the account.
 */
export async function processExternalInbound(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	source: InboundQueueSource,
	options: { finalAttempt?: boolean } = {},
): Promise<void> {
	try {
		await deliverExternal(env, payload, source);
	} catch (error) {
		if (options.finalAttempt && (await externalAccountTablesReady(env)))
			await noteOnAccount(
				env,
				source.accountId,
				"Kite could not deliver a synced message after several tries; it is still at the provider.",
			).catch(() => undefined);
		throw error;
	}
}

async function deliverExternal(env: CloudflareEnv, payload: InboundQueueMessage, source: InboundQueueSource) {
	const key = payload.rawR2Key;
	if (!(await externalAccountTablesReady(env))) return;
	const db = getDb(env);
	const [account] = await db
		.select({
			id: externalAccounts.id,
			userId: externalAccounts.userId,
			mailboxId: externalAccounts.mailboxId,
			mailboxOwnerId: mailboxes.userId,
			address: externalAccounts.address,
			preset: externalAccounts.preset,
			trustAuthResults: externalAccounts.trustAuthResults,
		})
		.from(externalAccounts)
		.innerJoin(mailboxes, eq(mailboxes.id, externalAccounts.mailboxId))
		.where(eq(externalAccounts.id, source.accountId))
		.limit(1);
	if (!account) {
		// Removed after the message was fetched: nothing receives it any more (spec §6.7).
		await env.BUCKET.delete(key);
		return;
	}
	const target = { mailboxId: account.mailboxId, userId: account.mailboxOwnerId };
	const stored = await storedFromRaw(env, target.mailboxId, key);
	if (stored) {
		await recoverAgentWork(env, target, stored, undefined);
		return;
	}
	const refusal = await externalSyncRefusal(env, account);
	if (refusal) {
		logger.warn("external.sync.refused_at_delivery", { accountId: account.id, reason: refusal });
		await rewindCursor(env, account.id, key);
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
		authenticationResults: externalAuthenticationResults(completeRawHeaderFields(raw), authservId),
		external: { accountId: account.id, read: source.read === true, starred: source.starred === true },
	});
	if (outcome.delivered) return;
	if (outcome.reason === "duplicate")
		logger.info("external.sync.duplicate_dropped", { accountId: account.id, duplicateOf: outcome.duplicateOf });
	if (outcome.reason === "attachment_limit" || outcome.reason === "unparseable")
		await noteOnAccount(env, account.id, `Kite did not deliver a message: ${outcome.detail}`);
}
