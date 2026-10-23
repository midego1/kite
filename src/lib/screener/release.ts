import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { mailboxes, messages } from "@/db/schema";
import { runInChunks } from "@/db/chunk-utils";
import { approveUndecidedAddresses, getScreenerSettings, screenerOwnAddresses } from "./settings";
import { recipientAddresses, SCREENING_STATUS, screenerAddress } from "./screener-utils";

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
	const matched: SenderMessage[] = [];
	const pageSize = 500;
	let cursor: { id: string; createdAt: Date } | undefined;
	for (;;) {
		const rows = await db
			.select({ ...senderColumns, createdAt: messages.createdAt })
			.from(messages)
			.where(
				and(
					eq(messages.mailboxId, mailboxId),
					eq(messages.direction, "inbound"),
					inArray(messages.status, statuses),
					single ? sql`lower(${messages.fromAddr}) LIKE ${likeContains(single)} ESCAPE '\\'` : undefined,
					cursor
						? or(
								lt(messages.createdAt, cursor.createdAt),
								and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
							)
						: undefined,
				),
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(pageSize);
		matched.push(
			...rows.filter((row) => {
				const sender = screenerAddress(row.fromAddr);
				return !!sender && addresses.has(sender);
			}),
		);
		// Advance using the unfiltered page, even when none of its senders matched.
		if (rows.length < pageSize) return matched;
		cursor = rows[rows.length - 1];
	}
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

/**
 * Writing to someone approves them: called after a send is accepted, for every To, Cc and Bcc address the
 * mailbox has not decided on yet. A denied sender stays denied. Nothing happens while the Screener is off.
 * It lives apart from `service.ts` because the send path must not import automatic reading: that would close
 * the cycle send -> agent schedule -> modules/invoke -> modules/host -> module-send -> send.
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
	// Not scheduled for automatic reading: a reply to the sender usually is what released it, so a reply
	// suggestion would only repeat it. Approving by hand or "Approve everyone you've written to" does schedule.
	await releaseScreenedFrom(db, mailbox.id, new Set(approved));
}
