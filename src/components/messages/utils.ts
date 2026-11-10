import type { Message, MessageListResponse } from "@/hooks/types";
import { authFetch } from "@/lib/auth/client";
import { fetchMessageCounts, markMessagesReadInCaches } from "@/hooks/utils";
import { planEmptyFolder } from "@/lib/mailboxes/scope-utils";
import { getEmailDisplayName, splitEmailAddressList } from "@/lib/email/address";
import { formatUserDate, getUserTimeZone, zonedDateFields } from "@/lib/time/utils";
import type { MailboxOption } from "@/components/mailbox-provider";
import type { EmailPageTitleInput } from "./types";
import type { MessageFolderConfig, MessageFolderName } from "./types";
import type { PageRange } from "./types";
import type { BulkMessageAction, BulkMessageResponse, PermanentDeleteFolder } from "@/app/api/messages/bulk/types";
import { SEND_PENDING_MOVE_MESSAGE, SEND_PENDING_MOVE_REFUSED } from "@/lib/messages/send-state-utils";
import { postBulkMessageBatch } from "./bulk-request";
import { draftDeletionConfirmation, draftsNeedingConfirmation } from "./bulk-request-utils";
import {
	BULK_ACTION_BATCH_SIZE,
	chunkArray,
	mergeBulkResponses,
	PartialBulkActionError,
} from "./bulk-action-batch-utils";
import { announcePhishingReports } from "./phishing-report";
import { offerUndoForMove } from "./undo-utils";
import { announceMessagesLeftView, bulkActionLeftView } from "./left-view-utils";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { showProgressToast } from "@/components/ui/progress-toast";
import type { EmptyFolderResponse } from "@/app/api/messages/empty/types";
import { msg, t } from "@/lib/i18n/translator";

/** Whether a search fell back to keyword matches only, which is only worth saying while there is a search. */
export function semanticUnavailableNote(query: string, semantic: MessageListResponse["semantic"]): boolean {
	return !!query.trim() && semantic === "unavailable";
}

export function getMessageParty(message: Message, folder: MessageFolderConfig["folder"], currentAccountName?: string) {
	if (folder === "drafts") return t("Draft");
	if (folder === "sent") return formatRecipientSummary(message.toAddr, message.toContactName);
	if (message.direction === "outbound" && currentAccountName) return currentAccountName;
	return message.fromContactName ?? (message.fromAddr ? getEmailDisplayName(message.fromAddr) : t("Unknown sender"));
}

/** "Maya Chen, +2" for a multi-recipient message, or just the one name. */
export function formatRecipientSummary(toAddr: string, firstContactName?: string | null): string {
	const entries = splitEmailAddressList(toAddr);
	if (entries.length === 0) return t("No recipient");
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
	if (folder === "drafts") return message.snippet || message.toAddr || t("No content");
	return message.snippet || t("No preview");
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

/** How the All mailboxes view names itself where a single mailbox would show its address. */
export const ALL_MAILBOXES_LABEL = msg("All mailboxes");

export function getMailboxAddress(
	mailbox: Pick<MailboxOption, "localPart" | "hostname"> | null | undefined,
): string | null {
	if (!mailbox) return null;
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

/** A folder's name on screen; a custom folder's is the name its owner typed, which is never translated. */
export function folderTitle(config: MessageFolderName): string {
	return config.folderId === undefined ? t(config.title) : config.title;
}

export function getEmailPageTitleCount(total: number, unread: number): number {
	return unread > 0 ? unread : total;
}

export function formatEmailPageTitle({ location, total, unread, emailAddress }: EmailPageTitleInput): string {
	if (location === t("Inbox")) return unread > 0 ? t("Inbox ({unread})", { unread }) : location;
	const count = getEmailPageTitleCount(total, unread);
	const suffix = emailAddress ? ` - ${emailAddress}` : "";
	return `${location} (${count})${suffix}`;
}

/** Folders whose list offers the "All mail / Unread" tabs; mail you sent or are writing is never unread. */
export function supportsUnreadFilter(folder: MessageFolderConfig["folder"]): boolean {
	return folder !== "sent" && folder !== "drafts";
}

/** The folder the selection toolbar offers moves from; a custom folder lists with folder "inbox" but may move there. */
export function getSelectionToolbarFolder(config: Pick<MessageFolderConfig, "folder" | "folderId">) {
	return config.folderId ? undefined : config.folder;
}

/**
 * Runs a bulk action in batches of `BULK_ACTION_BATCH_SIZE`. A batch that would delete the caller's own drafts
 * changes nothing and says how many (`settleDrafts` on the server); this first pass runs every batch without
 * `deleteDrafts`, so a batch with no drafts in it completes outright and one that does is set aside instead of
 * asking about it then and there, one true total across every batch set aside is asked about once, and only
 * then are those batches re-sent with `deleteDrafts: true` — never a separate, undercounted question per batch.
 *
 * On a later batch's failure or decline, the batches that already completed keep their effects (Undo, the list
 * refresh, the left-view announcement all still run below) instead of losing them; `PartialBulkActionError`
 * carries how far it got so the caller can say "N of M done" instead of a plain failure.
 */
export async function runBulkMessageAction(messageIds: string[], action: string, notify = true, folderId?: string) {
	const uniqueIds = Array.from(new Set(messageIds));
	const responses: BulkMessageResponse[] = [];
	const completedIds: string[] = [];
	const pendingDraftChunks: string[][] = [];
	let unconfirmedDrafts = 0;
	let failureMessage: string | null = null;

	/** Runs one batch and folds its outcome in; returns false when the run should stop at this batch. */
	async function runChunk(chunk: string[], deleteDrafts?: boolean): Promise<boolean> {
		let response: Response;
		try {
			response = await postBulkMessageBatch(
				{ messageIds: chunk, action: action as BulkMessageAction, folderId },
				deleteDrafts,
			);
		} catch {
			failureMessage = t("Unable to update selected messages");
			return false;
		}
		if (!deleteDrafts && response.status === 409) {
			const body = (await response
				.clone()
				.json()
				.catch(() => null)) as BulkMessageResponse | null;
			const drafts = draftsNeedingConfirmation(response.status, body);
			if (drafts !== null) {
				pendingDraftChunks.push(chunk);
				unconfirmedDrafts += drafts;
				return true;
			}
		}
		if (!response.ok) {
			const refused = (await response.json().catch(() => null)) as BulkMessageResponse | null;
			failureMessage =
				refused?.code === SEND_PENDING_MOVE_REFUSED
					? SEND_PENDING_MOVE_MESSAGE
					: t("Unable to update selected messages");
			return false;
		}
		const data = (await response.json().catch(() => null)) as BulkMessageResponse | null;
		if (!data) {
			failureMessage = t("Unable to update selected messages");
			return false;
		}
		responses.push(data);
		completedIds.push(...chunk);
		return true;
	}

	for (const chunk of chunkArray(uniqueIds, BULK_ACTION_BATCH_SIZE)) {
		if (!(await runChunk(chunk))) break;
	}

	if (!failureMessage && unconfirmedDrafts > 0) {
		if (await requestConfirmation(draftDeletionConfirmation(unconfirmedDrafts))) {
			for (const chunk of pendingDraftChunks) {
				if (!(await runChunk(chunk, true))) break;
			}
		} else if (completedIds.length === 0) {
			// Nothing ran yet (every batch either completed or is this drafts question): a plain cancel, matching
			// the pre-batching contract.
			return null;
		} else {
			failureMessage = t("Unable to update selected messages");
		}
	}

	const data = mergeBulkResponses(responses);
	if (completedIds.length > 0) {
		if (action === "read" || action === "unread") markMessagesReadInCaches(completedIds, action === "read");
		if (notify) window.dispatchEvent(new Event("kite:messages-changed"));
		offerUndoForMove(action, data);
		announceMessagesLeftView(bulkActionLeftView(action, completedIds, data));
		if (action === "phishing") announcePhishingReports(data);
	}
	if (failureMessage)
		throw new PartialBulkActionError(failureMessage, completedIds.length, uniqueIds.length, completedIds);
	if (completedIds.length === 0) return null;
	return data;
}

/** What `runDraftListAction` resolves to when the user declines the confirmation: nothing happened. */
export const LIST_ACTION_CANCELLED = "cancelled";

/**
 * An action on rows of the Drafts list. Drafts are private to their author, so Delete removes them outright
 * through the drafts API, as the composer's Discard does, after asking (there is no Undo); read state changes
 * as anywhere, and nothing moves a draft to another folder. Resolves to `LIST_ACTION_CANCELLED` when the user
 * declines the confirmation.
 */
/**
 * Deletes drafts in batches of `BULK_ACTION_BATCH_SIZE`, parallel within a batch and sequential across them, so
 * "Select all in Drafts" never fires up to a thousand DELETEs at once; a progress toast shows once there is more
 * than one batch. On a batch's failure the ones before it keep their effect (the list still refreshes below).
 */
export async function runDraftListAction(draftIds: string[], action: string) {
	if (action === "read" || action === "unread") return runBulkMessageAction(draftIds, action);
	if (action !== "trash" && action !== "delete") throw new Error("Drafts can only be sent or deleted");
	const confirmed = await requestConfirmation({
		title: draftIds.length === 1 ? t("Delete this draft?") : t("Delete {count} drafts?", { count: draftIds.length }),
		description: t("Deleted drafts and their attachments are removed at once. This can't be undone."),
		confirmLabel: t("Delete"),
	});
	if (!confirmed) return LIST_ACTION_CANCELLED;
	const uniqueIds = Array.from(new Set(draftIds));
	const chunks = chunkArray(uniqueIds, BULK_ACTION_BATCH_SIZE);
	const progress = chunks.length > 1 ? showProgressToast(t("Deleting drafts"), uniqueIds.length) : null;
	let done = 0;
	try {
		for (const chunk of chunks) {
			const responses = await Promise.all(
				chunk.map((id) => authFetch(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" })),
			);
			// A draft that is already gone (sent or deleted elsewhere) is fine.
			if (responses.some((response) => !response.ok && response.status !== 404)) {
				progress?.fail(
					t("{done} of {total} drafts deleted. The rest could not be deleted; please try again.", {
						done,
						total: uniqueIds.length,
					}),
				);
				throw new Error("Unable to delete drafts");
			}
			done += chunk.length;
			progress?.update(done);
		}
		progress?.succeed(t("{count, plural, one {# draft deleted} other {# drafts deleted}}", { count: done }));
	} finally {
		window.dispatchEvent(new Event("kite:messages-changed"));
	}
	return null;
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
		if (!response.ok) throw new Error(data.error ?? t("Unable to empty folder"));
		deletedTotal += data.deleted ?? 0;
		onProgress?.(deletedTotal, deletedTotal + (data.remaining ?? 0));
		if (!data.remaining || !data.deleted) break;
	}
	window.dispatchEvent(new Event("kite:messages-changed"));
	return deletedTotal;
}

/** Empty Trash or Spam over the mailboxes in view, from each mailbox's own counts. */
export async function planEmptyFolderInView(mailboxes: MailboxOption[], folder: PermanentDeleteFolder) {
	const counts = new Map(
		await Promise.all(
			mailboxes.map(
				async (mailbox) => [mailbox.id, (await fetchMessageCounts(mailbox.id))?.folders[folder]?.total ?? 0] as const,
			),
		),
	);
	return planEmptyFolder(
		mailboxes.map((mailbox) => ({
			id: mailbox.id,
			name: mailbox.displayName ?? mailbox.localPart,
			permission: mailbox.permission,
		})),
		(mailboxId) => counts.get(mailboxId) ?? 0,
	);
}
