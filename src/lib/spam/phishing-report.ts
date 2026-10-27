import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, domains, messages, routingRules } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { notifySuggestionsQuietly } from "@/lib/agent/auto-read/suggestion-events";
import type { SessionUser } from "@/lib/auth/types";
import { blockContact } from "@/lib/contacts/service";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { applySpamFeedbackWithReceipt } from "./feedback";
import type { PhishingReport } from "./phishing-report-types";
import { addReceiptExtras } from "./report-receipts";

/**
 * Why the sender stays unblocked: a forged From may carry the address of someone the owner writes
 * to, or one of this install's own domains, and blocking it would hide their real mail.
 */
async function keepSenderReason(
	env: CloudflareEnv,
	ownerUserId: string,
	sender: string,
): Promise<PhishingReport["notBlocked"]> {
	if (!sender.includes("@")) return "no_sender";
	const db = getDb(env);
	const [contact] = await db
		.select({ source: contacts.source })
		.from(contacts)
		.where(and(eq(contacts.userId, ownerUserId), eq(contacts.email, sender)))
		.limit(1);
	if (contact?.source === "manual" || contact?.source === "outbound") return "trusted_contact";
	const hostname = sender.slice(sender.lastIndexOf("@") + 1);
	const [own] = await db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).limit(1);
	return own ? "own_domain" : null;
}

/**
 * Whether blocking `sender` would add a block that was not there: no rule files the sender's mail in Trash
 * for this mailbox yet and the contact is not blocked. Only such a block is the report's to lift again.
 */
async function blockIsNew(
	env: CloudflareEnv,
	ownerUserId: string,
	mailboxId: string,
	sender: string,
): Promise<boolean> {
	const db = getDb(env);
	const [rule] = await db
		.select({ id: routingRules.id })
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, mailboxId),
				eq(routingRules.matchField, "email"),
				eq(routingRules.matchOperator, "exact"),
				eq(routingRules.matchValue, sender),
				eq(routingRules.action, "trash"),
			),
		)
		.limit(1);
	if (rule) return false;
	const [contact] = await db
		.select({ blocked: contacts.blocked })
		.from(contacts)
		.where(and(eq(contacts.userId, ownerUserId), eq(contacts.email, sender)))
		.limit(1);
	return !contact?.blocked;
}

/** The message's open phishing warning has been acted on, so it closes like "Mark as spam" closes it. Returns the ids closed. */
async function closePhishingWarnings(env: CloudflareEnv, userId: string, messageId: string): Promise<string[]> {
	const closed = await getDb(env)
		.update(agentSuggestions)
		.set({ status: "accepted", decidedAt: new Date(), decidedByUserId: userId })
		.where(
			and(
				eq(agentSuggestions.messageId, messageId),
				eq(agentSuggestions.kind, "phishing"),
				eq(agentSuggestions.status, "open"),
			),
		)
		.returning({ id: agentSuggestions.id });
	if (closed.length > 0)
		await notifySuggestionsQuietly(
			env,
			closed.map((row) => row.id),
		);
	return closed.map((row) => row.id);
}

/** A report and what an undo of it needs: where the message was and the receipt that takes back the rest. */
export type PhishingReportOutcome = {
	report: PhishingReport;
	undo: { id: string; status: string; folderId: string | null; receiptId: string | null };
};

/**
 * Report phishing: moves the message to Spam and trains on it like a spam report, with extra weight
 * on its fingerprint, then blocks the sender unless that could hide real mail (`keepSenderReason`) and
 * closes the message's phishing warning.
 */
async function reportPhishing(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
): Promise<PhishingReportOutcome | null> {
	const feedback = await applySpamFeedbackWithReceipt(env, user, messageId, "phishing");
	if (!feedback) return null;
	const db = getDb(env);
	const [message] = await db
		.select({ fromAddr: messages.fromAddr, mailboxId: messages.mailboxId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	const access = message?.mailboxId ? await getMailboxAccessLevel(db, user, message.mailboxId) : null;
	if (!message || !access?.canManage) return null;
	const sender = normalizeEmailAddress(message.fromAddr ?? "");
	const notBlocked = await keepSenderReason(env, access.mailbox.userId, sender);
	const newBlock = !notBlocked && (await blockIsNew(env, access.mailbox.userId, access.mailbox.id, sender));
	if (!notBlocked)
		await blockContact(env, {
			userId: access.mailbox.userId,
			mailboxId: access.mailbox.id,
			domainId: access.mailbox.domainId,
			address: sender,
		});
	const closedSuggestionIds = await closePhishingWarnings(env, user.id, messageId);
	await addReceiptExtras(env, feedback.receiptId, {
		...(newBlock ? { block: { userId: access.mailbox.userId, mailboxId: access.mailbox.id, address: sender } } : {}),
		...(closedSuggestionIds.length > 0 ? { closedSuggestionIds } : {}),
	});
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: access.mailbox.id,
		messageId,
		action: "email.phishing_report",
		metadata: { blocked: !notBlocked, ...(notBlocked ? { notBlocked } : {}) },
	});
	return {
		report: { messageId, blockedSender: notBlocked ? null : sender, notBlocked },
		undo: {
			id: messageId,
			status: feedback.previousStatus,
			folderId: feedback.previousFolderId,
			receiptId: feedback.receiptId,
		},
	};
}

/** Reports each message in turn; messages that cannot be reported (outbound, no access) are left out. */
export async function reportPhishingWithUndo(
	env: CloudflareEnv,
	user: SessionUser,
	messageIds: readonly string[],
): Promise<PhishingReportOutcome[]> {
	const outcomes: PhishingReportOutcome[] = [];
	for (const messageId of new Set(messageIds)) {
		const outcome = await reportPhishing(env, user, messageId);
		if (outcome) outcomes.push(outcome);
	}
	return outcomes;
}

export async function reportPhishingAll(
	env: CloudflareEnv,
	user: SessionUser,
	messageIds: readonly string[],
): Promise<PhishingReport[]> {
	return (await reportPhishingWithUndo(env, user, messageIds)).map((outcome) => outcome.report);
}
