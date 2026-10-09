import type { Message } from "@/hooks/types";
import { authFetch } from "@/lib/auth/client";
import { markMessagesReadInCaches } from "@/hooks/utils";
import { getEmailDisplayName, splitEmailAddressList } from "@/lib/email/address";
import { formatUserDate, getUserTimeZone, zonedDateFields } from "@/lib/time/utils";
import type { MailboxOption } from "@/components/mailbox-provider";
import type { EmailPageTitleInput } from "./types";
import type { MessageFolderConfig } from "./types";
import type { PageRange } from "./types";
import type { BulkMessageResponse, PermanentDeleteFolder } from "@/app/api/messages/bulk/types";
import { offerUndoForMove } from "./undo-utils";
import type { EmptyFolderResponse } from "@/app/api/messages/empty/types";

export function getMessageParty(message: Message, folder: MessageFolderConfig["folder"], currentAccountName?: string) {
	if (folder === "drafts") return "Draft";
	if (folder === "sent") return formatRecipientSummary(message.toAddr, message.toContactName);
	if (message.direction === "outbound" && currentAccountName) return currentAccountName;
	return message.fromContactName ?? (message.fromAddr ? getEmailDisplayName(message.fromAddr) : "Unknown sender");
}

/** "Maya Chen, +2" for a multi-recipient message, or just the one name. */
export function formatRecipientSummary(toAddr: string, firstContactName?: string | null): string {
	const entries = splitEmailAddressList(toAddr);
	if (entries.length === 0) return "No recipient";
	const first = firstContactName ?? getEmailDisplayName(entries[0]);
	return entries.length > 1 ? `${first}, +${entries.length - 1}` : first;
}

export function getMessagePartyClassName(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return "truncate font-medium text-red-600";

	const unread = isMessageListRowUnread(message);
	return `truncate ${unread ? "font-bold text-neutral-900" : "text-neutral-800"}`;
}

/** A grouped row is read only after every message represented by it is read. */
export function isMessageListRowUnread(message: Message): boolean {
	if (message.threadMessageIds) return (message.threadUnread ?? 0) > 0;
	return message.direction === "inbound" && !message.read;
}

export function getMessagePreview(message: Message, folder: MessageFolderConfig["folder"]) {
	if (folder === "drafts") return message.snippet || message.toAddr || "No content";
	return message.snippet || "No preview";
}

export function formatMessageListTimestamp(createdAt: string): string {
	const zone = getUserTimeZone();
	const date = zonedDateFields(new Date(createdAt), zone);
	const today = zonedDateFields(new Date(), zone);
	if (date.toISOString().slice(0, 10) === today.toISOString().slice(0, 10))
		return formatUserDate(createdAt, { hour: "2-digit", minute: "2-digit" });
	if (date.getUTCFullYear() === today.getUTCFullYear())
		return formatUserDate(createdAt, { month: "short", day: "2-digit" });
	return formatUserDate(createdAt, { month: "short", day: "2-digit", year: "numeric" });
}

export function getPageRange(offset: number, count: number, total: number): PageRange {
	if (total === 0 || count === 0) return { start: 0, end: 0, total };

	return {
		start: offset + 1,
		end: Math.min(offset + count, total),
		total,
	};
}

export function getMailboxAddress(
	mailbox: Pick<MailboxOption, "localPart" | "hostname"> | null | undefined,
): string | null {
	if (!mailbox) return null;
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getEmailPageTitleCount(total: number, unread: number): number {
	return unread > 0 ? unread : total;
}

export function formatEmailPageTitle({ location, total, unread, emailAddress }: EmailPageTitleInput): string {
	if (location === "Inbox") return unread > 0 ? `Inbox (${unread})` : "Inbox";
	const count = getEmailPageTitleCount(total, unread);
	const suffix = emailAddress ? ` - ${emailAddress}` : "";
	return `${location} (${count})${suffix}`;
}

export async function runBulkMessageAction(messageIds: string[], action: string, notify = true, folderId?: string) {
	const response = await authFetch("/api/messages/bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ messageIds, action, folderId }),
	});

	if (!response.ok) throw new Error("Unable to update selected messages");
	const data = (await response.json().catch(() => null)) as BulkMessageResponse | null;
	if (action === "read" || action === "unread") markMessagesReadInCaches(messageIds, action === "read");
	if (notify) window.dispatchEvent(new Event("kite:messages-changed"));
	offerUndoForMove(action, data);
	return data;
}

/** Messages sent per permanent-delete request, so progress can be shown between requests. */
export const PERMANENT_DELETE_BATCH_SIZE = 50;

/**
 * Permanently delete messages in batches, reporting progress after each one. Only
 * messages in Trash or Spam are deleted; the server skips the rest.
 */
export async function deleteMessagesForever(
	messageIds: string[],
	onProgress?: (done: number, total: number, deletedIds: string[]) => void,
): Promise<{ deleted: number; skipped: number }> {
	let done = 0;
	let deleted = 0;
	let skipped = 0;
	try {
		for (let index = 0; index < messageIds.length; index += PERMANENT_DELETE_BATCH_SIZE) {
			const batch = messageIds.slice(index, index + PERMANENT_DELETE_BATCH_SIZE);
			const data = await runBulkMessageAction(batch, "delete", false);
			deleted += data?.deleted ?? 0;
			skipped += data?.skipped ?? 0;
			done += batch.length;
			onProgress?.(done, messageIds.length, batch);
		}
	} finally {
		window.dispatchEvent(new Event("kite:messages-changed"));
	}
	return { deleted, skipped };
}

/**
 * Empty a mailbox's Trash or Spam. The API deletes in batches and reports what is
 * left, so keep calling until nothing remains (or a call stops making progress).
 */
export async function emptyMessageFolder(
	mailboxId: string,
	folder: PermanentDeleteFolder,
	onProgress?: (done: number, total: number) => void,
): Promise<number> {
	let deletedTotal = 0;
	for (;;) {
		const response = await authFetch("/api/messages/empty", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, folder }),
		});
		const data = (await response.json().catch(() => ({}))) as EmptyFolderResponse;
		if (!response.ok) throw new Error(data.error ?? "Unable to empty folder");
		deletedTotal += data.deleted ?? 0;
		onProgress?.(deletedTotal, deletedTotal + (data.remaining ?? 0));
		if (!data.remaining || !data.deleted) break;
	}
	window.dispatchEvent(new Event("kite:messages-changed"));
	return deletedTotal;
}
