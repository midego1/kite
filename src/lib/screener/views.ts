import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import type { SessionUser } from "@/lib/auth/types";
import {
	countScreenedMessages,
	getScreenerSettings,
	getSenderDecision,
	isScreenerAvailable,
	listDecidedAddresses,
	listScreenerSenders,
	listScreenerSettings,
} from "./settings";
import { isNewSenderRow, SCREENING_STATUS, screenerAddress } from "./screener-utils";
import type { ScreenerMessageStatus, ScreenerOverview } from "./screener-types";

type ListRow = { id: string; mailboxId: string | null; status: string; direction: string; fromAddr: string };

/**
 * Which list rows wait for a Screener decision: held mail, and undecided senders in Inbox-mode mailboxes.
 * Rows in other mailboxes cost no query, so lists of mailboxes without the Screener stay as they were.
 */
export async function screenerPendingRows(db: AppDatabase, rows: readonly ListRow[]): Promise<Set<string>> {
	const pending = new Set(rows.filter((row) => row.status === SCREENING_STATUS).map((row) => row.id));
	const candidates = rows.filter(
		(row): row is ListRow & { mailboxId: string } =>
			!!row.mailboxId && row.status === "received" && row.direction === "inbound",
	);
	if (candidates.length === 0) return pending;
	const settings = await listScreenerSettings(
		db,
		candidates.map((row) => row.mailboxId),
	);
	const inboxMode = new Set(
		[...settings].filter(([, value]) => value.enabled && value.mode === "inbox").map(([mailboxId]) => mailboxId),
	);
	const marked = candidates.filter((row) => inboxMode.has(row.mailboxId));
	if (marked.length === 0) return pending;
	const senders = marked.map((row) => screenerAddress(row.fromAddr)).filter((address): address is string => !!address);
	const decided = await listDecidedAddresses(db, [...inboxMode], senders);
	for (const row of marked) if (isNewSenderRow(row, true, decided.get(row.mailboxId) ?? new Set())) pending.add(row.id);
	return pending;
}

/** Whether the reader offers Approve and Deny for a message, and to whom. Null when it cannot be read. */
export async function getScreenerMessageStatus(
	db: AppDatabase,
	user: SessionUser,
	messageId: string,
): Promise<ScreenerMessageStatus | null> {
	const [message] = await db
		.select({
			mailboxId: messages.mailboxId,
			status: messages.status,
			direction: messages.direction,
			fromAddr: messages.fromAddr,
			userId: messages.userId,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isHiddenDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const address = screenerAddress(message.fromAddr);
	const settings = await getScreenerSettings(db, message.mailboxId);
	const base = {
		address,
		mailboxId: message.mailboxId,
		mode: settings?.enabled ? settings.mode : null,
		canManage: access.canManage,
	};
	if (message.status === SCREENING_STATUS) return { ...base, pending: true };
	if (!address || base.mode !== "inbox" || message.status !== "received" || message.direction !== "inbound")
		return { ...base, pending: false };
	const pending = (await getSenderDecision(db, message.mailboxId, address)) === null;
	return { ...base, pending };
}

export async function getScreenerOverview(db: AppDatabase, access: MailboxAccessLevel): Promise<ScreenerOverview> {
	const mailboxId = access.mailbox.id;
	const [available, settings, senders, waiting] = await Promise.all([
		isScreenerAvailable(db),
		getScreenerSettings(db, mailboxId),
		listScreenerSenders(db, mailboxId),
		countScreenedMessages(db, mailboxId),
	]);
	return {
		available,
		canManage: access.canManage,
		settings: settings ?? { enabled: false, mode: "screener" },
		approved: senders.filter((entry) => entry.decision === "approved"),
		denied: senders.filter((entry) => entry.decision === "denied"),
		waiting,
	};
}
