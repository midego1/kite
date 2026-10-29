import { authFetch, getClientSessionKey } from "@/lib/auth/client";
import type { MailboxOption } from "./mailbox-provider";
import { clearStoredState } from "@/hooks/use-stored-state";

let mailboxesCache: MailboxOption[] | null = null;
let mailboxesCacheSessionToken: string | null = null;
let mailboxesRequest: Promise<MailboxOption[]> | null = null;
let mailboxesRequestSessionToken: string | null = null;
let cacheGeneration = 0;
export const SELECTED_MAILBOX_STORAGE_KEY = "selected-mailbox-id";
/** Browser preferences of the All mailboxes view (see appearance-preferences.ts): on, the hidden mailboxes, the last From. */
export const ALL_MAILBOXES_STORAGE_KEY = "kite-all-mailboxes";
export const ALL_MAILBOXES_HIDDEN_STORAGE_KEY = "kite-all-mailboxes-hidden";
export const LAST_FROM_STORAGE_KEY = "kite-compose-last-from";

/**
 * The primary mailbox is the one at the account address; it is the only mailbox
 * whose name and avatar follow the profile.
 */
export function isIdentityMailbox(mailbox: Pick<MailboxOption, "type" | "isPrimary">): boolean {
	return mailbox.type === "personal" && !!mailbox.isPrimary;
}

/** Fired after something the mailbox list carries changed elsewhere (a connected account's From addresses). */
export const MAILBOXES_CHANGED_EVENT = "kite:mailboxes-changed";

export function clearMailboxesCache() {
	cacheGeneration += 1;
	mailboxesCache = null;
	mailboxesCacheSessionToken = null;
	mailboxesRequest = null;
	mailboxesRequestSessionToken = null;
}

export function clearMailboxClientState() {
	clearMailboxesCache();
	if (typeof window !== "undefined") {
		localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
		// The All mailboxes view, its filter and the last From belong to the account that signed out.
		clearStoredState([ALL_MAILBOXES_STORAGE_KEY, ALL_MAILBOXES_HIDDEN_STORAGE_KEY, LAST_FROM_STORAGE_KEY]);
	}
}

export async function fetchMailboxOptions(force = false): Promise<MailboxOption[]> {
	const sessionToken = getClientSessionKey();
	if (!force && mailboxesCache && mailboxesCacheSessionToken === sessionToken) return mailboxesCache;
	if (!force && mailboxesRequest && mailboxesRequestSessionToken === sessionToken) return mailboxesRequest;

	const requestGeneration = cacheGeneration;
	mailboxesRequestSessionToken = sessionToken;
	mailboxesRequest = authFetch("/api/mailboxes")
		.then((res) => res.json())
		.then((data) => {
			const items = ((data as { mailboxes?: MailboxOption[] }).mailboxes ?? []).map((m) => ({
				id: m.id,
				domainId: m.domainId,
				localPart: m.localPart,
				hostname: m.hostname,
				displayName: m.displayName,
				signature: m.signature,
				autoReplyEnabled: m.autoReplyEnabled,
				autoReplySubject: m.autoReplySubject,
				autoReplyBody: m.autoReplyBody,
				hasAvatar: m.hasAvatar,
				type: m.type,
				permission: m.permission,
				isPrimary: m.isPrimary,
				senderAddresses: m.senderAddresses,
				externalIdentities: m.externalIdentities,
				screener: m.screener,
			}));
			if (requestGeneration === cacheGeneration) {
				mailboxesCache = items;
				mailboxesCacheSessionToken = sessionToken;
			}
			return items;
		})
		.finally(() => {
			if (requestGeneration === cacheGeneration) {
				mailboxesRequest = null;
				mailboxesRequestSessionToken = null;
			}
		});

	return mailboxesRequest;
}
