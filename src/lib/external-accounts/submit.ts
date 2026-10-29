import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import { renewJobClaim } from "@/lib/email/job-claim";
import { buildMimeMessage, mintMessageId } from "@/lib/email/mime-build-utils";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";
import { openImapSession } from "@/lib/imap/session";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { submitMessage } from "@/lib/smtp/session";
import type { SmtpLogin } from "@/lib/smtp/types";
import { connectRefusal } from "./access";
import { externalAccountTablesReady } from "./errors";
import { SEND_BLOCK_TEXT, sendBlock } from "./identity-utils";
import { findPreset } from "./presets-utils";
import { readSmtpVerified, writeSmtpVerified } from "./send-state";
import { appendRecentError, type ExternalAccountRow } from "./serialize-utils";
import {
	APPEND_SENT_KIND,
	appendRetryDelaySeconds,
	classifySubmitFailure,
	MAX_APPEND_ATTEMPTS,
	pickSentFolder,
	sentRawKey,
	submissionEnvelope,
	tooLargeMessage,
	type AppendSentMessage,
} from "./submit-utils";

const log = createLogger("external");

/** A send through an account the provider did not take; `action` says whether the outbound job tries again. */
export class SubmissionError extends Error {
	constructor(
		message: string,
		readonly action: "retry" | "fail",
		readonly deliveryUnknown = false,
	) {
		super(message);
		this.name = "SubmissionError";
	}
}

/**
 * Which send this is: the account, the user it is sent for, the mailbox it is sent from, Kite's id of the message and
 * the outbound job that holds the claim on it.
 */
export type SubmissionTarget = {
	accountId: string;
	userId: string;
	mailboxId: string;
	messageId: string;
	jobId: string;
};

/**
 * How often a send under way renews its job's claim. Far below `STUCK_SENDING_AFTER_MS` (10 minutes), which a slow
 * provider could otherwise outlast with the SMTP timeouts (2 minutes a command, 10 after the data): the send would
 * look stalled and could be taken back and sent again while this one may still be delivered.
 */
const CLAIM_HEARTBEAT_MS = 60_000;

const TAKEN_BACK = "The send was taken back before it was delivered";

type Account = ExternalAccountRow & { password: string };

/**
 * The account a send goes through, checked again when the send runs (a scheduled or undoable send may wait): it must
 * still exist, belong to the sender and be allowed to send. Its password is opened here and nowhere else.
 */
async function openAccount(env: CloudflareEnv, target: SubmissionTarget): Promise<Account> {
	const removed = new SubmissionError("The account was removed", "fail");
	if (!(await externalAccountTablesReady(env))) throw removed;
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, target.accountId), eq(externalAccounts.userId, target.userId)))
		.limit(1);
	if (!row) throw removed;
	await assertStillSendable(env, target, row.address, row.mailboxId);
	const verified = (await readSmtpVerified(env, [row.id])).get(row.id) ?? null;
	const block = sendBlock(
		{ ...row, hasPassword: row.secret.length > 0, smtpVerifiedAt: verified },
		await connectRefusal(env, target.userId),
	);
	if (block) throw new SubmissionError(`Not sent from ${row.address}. ${SEND_BLOCK_TEXT[block]}`, "fail");
	let password: string | null = null;
	try {
		password = await openSetting(env, row.secret);
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
	}
	if (!password) {
		await markAuthFailed(env, row, "The saved password can no longer be opened. Reconnect the account.");
		throw new SubmissionError(`Not sent from ${row.address}. ${SEND_BLOCK_TEXT.reconnect}`, "fail");
	}
	return { ...row, password };
}

/**
 * What authorization checked when the send was made, checked again when it runs: the account still delivers into the
 * mailbox it is sent from, and its owner is not disabled and may still send from that mailbox.
 */
async function assertStillSendable(
	env: CloudflareEnv,
	target: SubmissionTarget,
	address: string,
	accountMailboxId: string,
): Promise<void> {
	const refuse = (reason: string) => new SubmissionError(`Not sent from ${address}. ${reason}`, "fail");
	if (accountMailboxId !== target.mailboxId)
		throw refuse("The account's mail now goes to another mailbox; send from that mailbox instead.");
	const db = getDb(env);
	const [owner] = await db
		.select({ id: users.id, role: users.role, disabled: users.disabled })
		.from(users)
		.where(eq(users.id, target.userId))
		.limit(1);
	if (!owner || owner.disabled) throw refuse("The sender's Kite account is disabled.");
	const access = await getMailboxAccessLevel(db, owner, target.mailboxId);
	if (!access?.canSendOnBehalf) throw refuse("You can no longer send from this mailbox.");
}

/** The password stopped working: the account shows Reconnect, and the address leaves the From menu. */
async function markAuthFailed(env: CloudflareEnv, row: ExternalAccountRow, message: string): Promise<void> {
	const now = new Date();
	await getDb(env)
		.update(externalAccounts)
		.set({
			status: "auth_failed",
			lastError: message,
			recentErrors: appendRecentError(row.recentErrors, message, now),
			updatedAt: now,
		})
		.where(eq(externalAccounts.id, row.id));
	await writeSmtpVerified(env, row.id, null);
}

function smtpLogin(account: Account): SmtpLogin {
	return {
		host: account.smtpHost!,
		port: account.smtpPort!,
		security: account.smtpSecurity!,
		username: account.username,
		password: account.password,
	};
}

/**
 * Sends one message through the account's own SMTP submission server (spec §7.3): the MIME is built here
 * (`buildMimeMessage`, with Kite's Message-ID on the account's domain), stored at `sent/<messageId>.eml` before it
 * goes out, then submitted with Bcc in the envelope only. The Message-ID is derived from Kite's message id, so a send
 * that is tried again after a 4xx carries the same one. Failures become a `SubmissionError` whose `action` the
 * outbound job follows; a 535 also sets the account to `auth_failed`.
 */
export async function sendViaSubmission(
	env: CloudflareEnv,
	target: SubmissionTarget,
	message: OutboundProviderMessage,
	attempt = 1,
): Promise<{ messageId: string; rawR2Key: string; appendSent: boolean }> {
	const account = await openAccount(env, target);
	const built = buildMimeMessage(message, { messageId: mintMessageId(account.address, target.messageId) });
	const preset = findPreset(account.preset);
	if (preset?.maxMessageBytes && built.raw.byteLength > preset.maxMessageBytes)
		throw new SubmissionError(tooLargeMessage(built.raw.byteLength, preset.maxMessageBytes, preset.label), "fail");
	const rawR2Key = sentRawKey(target.messageId);
	await storeSentRaw(env, target.messageId, rawR2Key, built.raw);
	const db = getDb(env);
	const renewClaim = () => renewJobClaim(db, target.jobId);
	const heartbeat = setInterval(() => void renewClaim().catch(() => undefined), CLAIM_HEARTBEAT_MS);
	const started = Date.now();
	try {
		await submitMessage(env, smtpLogin(account), submissionEnvelope(message), built.raw, undefined, {
			// The last moment the send can still be stopped without anything reaching the provider.
			beforeData: async () => {
				if (!(await renewClaim())) throw new SubmissionError(TAKEN_BACK, "fail");
			},
		});
	} catch (error) {
		const failure = classifySubmitFailure(error, attempt);
		if (failure.authFailed) await markAuthFailed(env, account, failure.message);
		// Nothing went out: the stored bytes go too. A retry rewrites them; "delivery unknown" keeps them on its row.
		if (failure.action === "fail" && !failure.deliveryUnknown) await dropSentRaw(env, target.messageId, rawR2Key);
		log.warn("external.submit.failed", {
			accountId: account.id,
			messageId: target.messageId,
			attempt,
			action: failure.action,
			deliveryUnknown: failure.deliveryUnknown,
			authFailed: failure.authFailed,
			durationMs: Date.now() - started,
		});
		throw new SubmissionError(failure.message, failure.action, failure.deliveryUnknown);
	} finally {
		clearInterval(heartbeat);
	}
	log.info("external.submit.sent", {
		accountId: account.id,
		messageId: target.messageId,
		attempt,
		bytes: built.raw.byteLength,
		durationMs: Date.now() - started,
	});
	return { messageId: built.messageId.slice(1, -1), rawR2Key, appendSent: account.appendSent };
}

/**
 * Stores the bytes about to go out and names them on the still queued row at once, so whatever happens next (a crash
 * mid-send, "delivery unknown") the object belongs to a message and is deleted with it.
 */
async function storeSentRaw(env: CloudflareEnv, messageId: string, key: string, raw: Uint8Array): Promise<void> {
	await env.BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
	await getDb(env)
		.update(messages)
		.set({ rawR2Key: key })
		.where(and(eq(messages.id, messageId), eq(messages.status, "queued")));
}

/** A send that certainly did not go out keeps no stored bytes. */
async function dropSentRaw(env: CloudflareEnv, messageId: string, key: string): Promise<void> {
	await getDb(env)
		.update(messages)
		.set({ rawR2Key: null })
		.where(and(eq(messages.id, messageId), eq(messages.rawR2Key, key)));
	await env.BUCKET.delete(key);
}

/** Queues the Sent copy at the provider (spec §7.4); it never holds up or fails the send. */
export async function enqueueAppendSent(env: CloudflareEnv, accountId: string, messageId: string): Promise<void> {
	await env.OUTBOUND_QUEUE.send({ kind: APPEND_SENT_KIND, accountId, messageId, attempt: 1 });
}

/**
 * Signs in to the account's IMAP server and appends the stored bytes to its Sent folder with `\Seen`. With
 * `alreadyTriedId` (a later try, whose earlier answer may have been lost after the server took the message) the folder
 * is searched for that Message-ID first, and nothing is appended when it is there.
 */
async function appendToSent(
	env: CloudflareEnv,
	row: ExternalAccountRow,
	rawR2Key: string,
	alreadyTriedId: string | null,
): Promise<"saved" | "present"> {
	const object = await env.BUCKET.get(rawR2Key);
	if (!object) throw new Error("The sent message is no longer stored");
	const raw = new Uint8Array(await object.arrayBuffer());
	const password = await openSetting(env, row.secret).catch(() => null);
	if (!password) throw new Error("The saved password is not available");
	const session = await openImapSession(env, {
		host: row.imapHost,
		port: row.imapPort,
		security: row.imapSecurity,
		username: row.username,
		password,
	});
	try {
		const folder = pickSentFolder(await session.listMailboxes());
		if (!folder) throw new Error("The account has no Sent folder");
		if (alreadyTriedId && (await session.hasMessageId(folder, `<${alreadyTriedId}>`))) return "present";
		await session.append(folder, ["\\Seen"], raw);
		return "saved";
	} finally {
		await session.close().catch(() => undefined);
	}
}

/**
 * Appends a message sent through an account to the account's Sent folder with `\Seen`, from the exact bytes that went
 * out. Tried `MAX_APPEND_ATTEMPTS` times; a failure is logged and shown in the account's recent errors, never thrown,
 * so the queue does not retry it on its own and the send itself is never affected.
 */
export async function processAppendSent(env: CloudflareEnv, payload: AppendSentMessage): Promise<void> {
	const attempt = payload.attempt ?? 1;
	if (!(await externalAccountTablesReady(env))) return;
	const db = getDb(env);
	const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, payload.accountId)).limit(1);
	const [message] = await db
		.select({ userId: messages.userId, rawR2Key: messages.rawR2Key, providerMessageId: messages.providerMessageId })
		.from(messages)
		.where(eq(messages.id, payload.messageId))
		.limit(1);
	// Only the account owner's own sent message, from the bytes Kite stored for it.
	if (!row || !message || message.userId !== row.userId || message.rawR2Key !== sentRawKey(payload.messageId)) return;
	// Turned off, or an account that needs reconnecting: no sign-in is attempted with a password known to fail.
	if (!row.appendSent || row.status === "auth_failed" || row.status === "disabled") return;
	if (await connectRefusal(env, row.userId)) return;
	try {
		const outcome = await appendToSent(env, row, message.rawR2Key, attempt > 1 ? message.providerMessageId : null);
		log.info(outcome === "present" ? "external.append_sent.present" : "external.append_sent.saved", {
			accountId: row.id,
			messageId: payload.messageId,
			attempt,
		});
	} catch (error) {
		const reason = error instanceof Error && error.message ? error.message.slice(0, 300) : "unknown error";
		log.warn("external.append_sent.failed", { accountId: row.id, messageId: payload.messageId, attempt, reason });
		if (attempt < MAX_APPEND_ATTEMPTS) {
			await env.OUTBOUND_QUEUE.send(
				{ ...payload, attempt: attempt + 1 },
				{ delaySeconds: appendRetryDelaySeconds(attempt) },
			);
			return;
		}
		await db
			.update(externalAccounts)
			.set({
				recentErrors: appendRecentError(row.recentErrors, `Saving a copy in Sent failed: ${reason}`, new Date()),
				updatedAt: new Date(),
			})
			.where(eq(externalAccounts.id, row.id));
	}
}
