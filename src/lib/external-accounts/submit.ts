import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import { buildMimeMessage, mintMessageId } from "@/lib/email/mime-build-utils";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";
import { openImapSession } from "@/lib/imap/session";
import { createLogger } from "@/lib/logger.mjs";
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

/** Which send this is: the account, the user it is sent for, and Kite's id of the message. */
export type SubmissionTarget = { accountId: string; userId: string; messageId: string };

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
	await env.BUCKET.put(rawR2Key, built.raw, { httpMetadata: { contentType: "message/rfc822" } });
	const started = Date.now();
	try {
		await submitMessage(env, smtpLogin(account), submissionEnvelope(message), built.raw);
	} catch (error) {
		const failure = classifySubmitFailure(error, attempt);
		if (failure.authFailed) await markAuthFailed(env, account, failure.message);
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

/** Queues the Sent copy at the provider (spec §7.4); it never holds up or fails the send. */
export async function enqueueAppendSent(env: CloudflareEnv, accountId: string, messageId: string): Promise<void> {
	await env.OUTBOUND_QUEUE.send({ kind: APPEND_SENT_KIND, accountId, messageId, attempt: 1 });
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
		.select({ userId: messages.userId, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, payload.messageId))
		.limit(1);
	// Only the account owner's own sent message, from the bytes Kite stored for it.
	if (!row || !message || message.userId !== row.userId || message.rawR2Key !== sentRawKey(payload.messageId)) return;
	// Turned off, or an account that needs reconnecting: no sign-in is attempted with a password known to fail.
	if (!row.appendSent || row.status === "auth_failed" || row.status === "disabled") return;
	if (await connectRefusal(env, row.userId)) return;
	try {
		const object = await env.BUCKET.get(message.rawR2Key);
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
			await session.append(folder, ["\\Seen"], raw);
		} finally {
			await session.close().catch(() => undefined);
		}
		log.info("external.append_sent.saved", { accountId: row.id, messageId: payload.messageId, attempt });
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
			})
			.where(eq(externalAccounts.id, row.id));
	}
}
