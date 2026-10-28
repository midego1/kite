import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { queryInChunks } from "@/db/chunk-utils";
import { scheduleAgentWork } from "@/lib/agent/auto-read/schedule";
import type { SessionUser } from "@/lib/auth/types";
import { blockContact, unblockContact } from "@/lib/contacts/service";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { applySpamFeedback } from "@/lib/spam/feedback";
import {
	approveUndecidedAddresses,
	deleteSenderDecision,
	getScreenerSettings,
	getSenderDecision,
	recordSenderDecision,
	screenerOwnAddresses,
} from "./settings";
import { messagesFromSenders, releaseScreenedFrom, setMessageStatus } from "./release";
import type { SenderMessage } from "./release";
import { recipientAddresses, SCREENER_FOLLOW_UP_LIMIT, SCREENING_STATUS, screenerAddress } from "./screener-utils";
import type { ScreenerDecisionResult } from "./screener-types";

type Mailbox = MailboxAccessLevel["mailbox"];

/** Automatic reading skipped these while they waited, so they are scheduled now that the sender is approved. */
async function scheduleApprovedMail(env: CloudflareEnv, mailbox: Mailbox, rows: SenderMessage[]) {
	for (const row of rows.slice(0, SCREENER_FOLLOW_UP_LIMIT)) {
		try {
			await scheduleAgentWork(env, {
				mailboxId: mailbox.id,
				sourceMessageId: row.id,
				ownerUserId: mailbox.userId,
				sender: row.fromAddr,
				status: row.status,
				folderId: row.folderId,
				spamVerdict: row.spamVerdict,
				spamAnalysisError: row.spamAnalysisError,
				released: true,
			});
		} catch (error) {
			console.error(`Agent work scheduling failed for approved message ${row.id}`, error);
		}
	}
}

/** The statuses a sender's waiting mail has: held in the Screener, or marked in the Inbox in Inbox mode. */
async function waitingStatuses(db: AppDatabase, mailboxId: string): Promise<string[]> {
	const settings = await getScreenerSettings(db, mailboxId);
	return settings?.enabled && settings.mode === "inbox" ? [SCREENING_STATUS, "received"] : [SCREENING_STATUS];
}

export async function approveSender(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	address: string,
): Promise<ScreenerDecisionResult> {
	const db = getDb(env);
	const mailbox = access.mailbox;
	const statuses = await waitingStatuses(db, mailbox.id);
	const previous = await getSenderDecision(db, mailbox.id, address);
	const marked =
		previous === null && statuses.includes("received")
			? await messagesFromSenders(db, mailbox.id, ["received"], new Set([address]))
			: [];
	await recordSenderDecision(db, {
		mailboxId: mailbox.id,
		address,
		decision: "approved",
		source: "manual",
		userId: user.id,
	});
	if (previous === "denied") await unblockContact(env, { userId: mailbox.userId, mailboxId: mailbox.id, address });
	const released = await releaseScreenedFrom(db, mailbox.id, new Set([address]));
	await scheduleApprovedMail(env, mailbox, [...released, ...marked]);
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: mailbox.id,
		action: "screener.approve",
		metadata: { address, released: released.length },
	});
	return { address, decision: "approved", movedMessageIds: released.map((row) => row.id), blocked: false };
}

export async function denySender(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	address: string,
): Promise<ScreenerDecisionResult> {
	const db = getDb(env);
	const mailbox = access.mailbox;
	const previous = await getSenderDecision(db, mailbox.id, address);
	const statuses = previous === null ? await waitingStatuses(db, mailbox.id) : [SCREENING_STATUS];
	const waiting = await messagesFromSenders(db, mailbox.id, statuses, new Set([address]));
	await recordSenderDecision(db, {
		mailboxId: mailbox.id,
		address,
		decision: "denied",
		source: "manual",
		userId: user.id,
	});
	const trained = waiting.slice(0, SCREENER_FOLLOW_UP_LIMIT);
	// Trained like "Mark as spam", without the extra fingerprint weight a phishing report adds.
	for (const row of trained) await applySpamFeedback(env, user, row.id, "spam");
	await setMessageStatus(
		db,
		waiting.slice(SCREENER_FOLLOW_UP_LIMIT).map((row) => row.id),
		"spam",
		{ folderId: null },
	);
	await blockContact(env, { userId: mailbox.userId, mailboxId: mailbox.id, domainId: mailbox.domainId, address });
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: mailbox.id,
		action: "screener.deny",
		metadata: { address, moved: waiting.length },
	});
	return { address, decision: "denied", movedMessageIds: waiting.map((row) => row.id), blocked: true };
}

/** Forgets a decision. Removing a denial lifts the block; `restoreMessageIds` puts mail an approval released back. */
export async function removeSenderDecision(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	address: string,
	restoreMessageIds: readonly string[] = [],
): Promise<{ removed: boolean; restored: number }> {
	const db = getDb(env);
	const mailbox = access.mailbox;
	const previous = await deleteSenderDecision(db, mailbox.id, address);
	if (previous === "denied") await unblockContact(env, { userId: mailbox.userId, mailboxId: mailbox.id, address });
	let restored: string[] = [];
	if (previous === "approved" && restoreMessageIds.length > 0) {
		const rows = await queryInChunks([...restoreMessageIds], (chunk) =>
			db
				.select({ id: messages.id, fromAddr: messages.fromAddr })
				.from(messages)
				.where(
					and(
						inArray(messages.id, chunk),
						eq(messages.mailboxId, mailbox.id),
						eq(messages.status, "received"),
						eq(messages.direction, "inbound"),
					),
				),
		);
		restored = rows.filter((row) => screenerAddress(row.fromAddr) === address).map((row) => row.id);
		await setMessageStatus(db, restored, SCREENING_STATUS);
	}
	if (previous)
		await createAuditLog(env, {
			actorUserId: user.id,
			mailboxId: mailbox.id,
			action: "screener.forget",
			metadata: { address, decision: previous, restored: restored.length },
		});
	return { removed: !!previous, restored: restored.length };
}

/** Approves, once, everyone this mailbox has sent mail to, and releases their held mail. */
export async function approveEveryoneWrittenTo(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
): Promise<{ approved: number; released: number }> {
	const db = getDb(env);
	const mailbox = access.mailbox;
	const sent = await db
		.select({ toAddr: messages.toAddr, ccAddr: messages.ccAddr, bccAddr: messages.bccAddr })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailbox.id), eq(messages.direction, "outbound"), eq(messages.status, "sent")))
		.orderBy(desc(messages.createdAt))
		.limit(5000);
	const own = await screenerOwnAddresses(db, mailbox);
	const addresses = recipientAddresses(...sent.flatMap((row) => [row.toAddr, row.ccAddr, row.bccAddr])).filter(
		(address) => !own.has(address),
	);
	const approved = await approveUndecidedAddresses(db, mailbox.id, addresses, "sent", user.id);
	const released = await releaseScreenedFrom(db, mailbox.id, new Set(approved));
	await scheduleApprovedMail(env, mailbox, released);
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: mailbox.id,
		action: "screener.approve_sent",
		metadata: { approved: approved.length, released: released.length },
	});
	return { approved: approved.length, released: released.length };
}
