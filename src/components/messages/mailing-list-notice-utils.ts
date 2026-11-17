import type { MailingListInfo } from "@/lib/email/mailing-list-types";
import { normalizeEmailAddress } from "@/lib/email/address";

/** One capped list for every dismissal, never a key per list, so storage stays bounded. */
export const MAILING_LIST_NOTICE_STORAGE_KEY = "kite-mailing-list-notice-dismissed";
const MAX_DISMISSED_LISTS = 500;
const MAX_KEY_LENGTH = 320;

/** Statuses the notice never shows on: spam (unsubscribing confirms the address), Trash, and held mail. */
const HIDDEN_STATUSES = new Set(["spam", "trash", "screening"]);

type NoticeMessage = { direction: string; status: string; fromAddr: string };

/**
 * What a dismissal applies to: the list (its `List-Id`), or the sender when the message names no list, so dismissing
 * one newsletter never hides another from the same platform. Null when there is nothing to key on.
 */
export function mailingListDismissKey(list: Pick<MailingListInfo, "id">, fromAddr: string): string | null {
	const key = list.id ? `list:${list.id}` : fromAddr ? `sender:${normalizeEmailAddress(fromAddr)}` : null;
	return key && key.length <= MAX_KEY_LENGTH && key !== "sender:" ? key : null;
}

/** Whether a message gets the notice at all, before any dismissal is looked at. */
export function shouldOfferMailingListNotice(
	message: NoticeMessage | null | undefined,
	list: MailingListInfo | null | undefined,
): list is MailingListInfo {
	return !!message && !!list && message.direction === "inbound" && !HIDDEN_STATUSES.has(message.status);
}

/** The stored keys (the parsed JSON value), oldest first; anything malformed reads as none, never an error. */
export function parseDismissedKeys(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((key): key is string => typeof key === "string" && key.length <= MAX_KEY_LENGTH)
		: [];
}

/** `keys` with `key` added as the newest (or removed), capped to the newest `MAX_DISMISSED_LISTS`. */
export function updateDismissedKeys(keys: readonly string[], key: string, dismissed: boolean): string[] {
	const rest = keys.filter((existing) => existing !== key);
	return dismissed ? [...rest, key].slice(-MAX_DISMISSED_LISTS) : rest;
}
