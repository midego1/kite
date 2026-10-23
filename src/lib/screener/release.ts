import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { mailboxes, messages } from "@/db/schema";
import { runInChunks } from "@/db/chunk-utils";
import { approveUndecidedAddresses, getScreenerSettings, screenerOwnAddresses } from "./settings";
import { recipientAddresses, SCREENER_FOLLOW_UP_LIMIT, SCREENING_STATUS, screenerAddress } from "./screener-utils";

type ReleaseMailbox = { id: string; userId: string };

export type SenderMessage = {
	id: string;
	fromAddr: string;
	status: string;
	folderId: string | null;
	spamVerdict: string | null;
	spamAnalysisError: string | null;
};

const senderColumns = {
	id: messages.id,
	fromAddr: messages.fromAddr,
	status: messages.status,
	folderId: messages.folderId,
	spamVerdict: messages.spamVerdict,
	spamAnalysisError: messages.spamAnalysisError,
};

function likeContains(value: string): string {
	return `%${value.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

/** Inbound messages of one mailbox in `statuses` whose sender is one of `addresses`, newest first. */
export async function messagesFromSenders(
	db: AppDatabase,
	mailboxId: string,
	statuses: string[],
	addresses: ReadonlySet<string>,
): Promise<SenderMessage[]> {
	if (addresses.size === 0 || statuses.length === 0) return [];
	// One address narrows the scan in SQL; the exact comparison below settles display-name forms.
	const [single] = addresses.size === 1 ? [...addresses] : [];
	const rows = await db
		.select(senderColumns)
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				eq(messages.direction, "inbound"),
				inArray(messages.status, statuses),
				single ? sql`lower(${messages.fromAddr}) LIKE ${likeContains(single)} ESCAPE '\\'` : undefined,
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(5000);
	return rows.filter((row) => {
		const sender = screenerAddress(row.fromAddr);
		return !!sender && addresses.has(sender);
	});
}

export async function setMessageStatus(
	db: AppDatabase,
	ids: string[],
	status: string,
	extra: { folderId?: null } = {},
): Promise<void> {
	await runInChunks(ids, (chunk) =>
		db
			.update(messages)
			.set({ status, ...extra })
			.where(inArray(messages.id, chunk)),
	);
}

/** Moves held mail from `addresses` back to where delivery would have put it: the Inbox or its folder. */
export async function releaseScreenedFrom(db: AppDatabase, mailboxId: string, addresses: ReadonlySet<string>) {
	const held = await messagesFromSenders(db, mailboxId, [SCREENING_STATUS], addresses);
	await setMessageStatus(
		db,
		held.map((row) => row.id),
		"received",
	);
	return held.map((row) => ({ ...row, status: "received" }));
}

/** Automatic reading skipped these while they waited, so they are scheduled now that the sender is approved. */
export async function scheduleApprovedMail(env: CloudflareEnv, mailbox: ReleaseMailbox, rows: SenderMessage[]) {
	if (rows.length === 0) return;
	// Loaded lazily: `send.ts` imports this file, and a static import would close the cycle
	// send -> schedule -> modules/invoke -> modules/host -> module-send -> send, which unbinds moduleHost.
	const { scheduleAgentWork } = await import("@/lib/agent/auto-read/schedule");
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
			});
		} catch (error) {
			console.error(`Agent work scheduling failed for approved message ${row.id}`, error);
		}
	}
}

/**
 * Writing to someone approves them: called after a send is accepted, for every To, Cc and Bcc address the
 * mailbox has not decided on yet. A denied sender stays denied. Nothing happens while the Screener is off.
 * It lives apart from `service.ts` so the send path does not import contacts, spam training and audit code.
 */
export async function approveSentRecipients(
	env: CloudflareEnv,
	mailboxId: string,
	userId: string,
	recipients: readonly string[],
): Promise<void> {
	const db = getDb(env);
	const settings = await getScreenerSettings(db, mailboxId);
	if (!settings?.enabled) return;
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
	if (!mailbox) return;
	const own = await screenerOwnAddresses(db, mailbox);
	const addresses = recipientAddresses([...recipients]).filter((address) => !own.has(address));
	const approved = await approveUndecidedAddresses(db, mailbox.id, addresses, "sent", userId);
	if (approved.length === 0) return;
	const released = await releaseScreenedFrom(db, mailbox.id, new Set(approved));
	await scheduleApprovedMail(env, mailbox, released);
}
