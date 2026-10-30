import { getEmailAddress, normalizeEmailAddress } from "@/lib/email/address";
import { canManageMailboxMail, canSendFromMailbox } from "@/lib/mailboxes/scope-utils";
import type { MailboxPermission } from "@/lib/mailboxes/types";

/** Whether the address is one of the mailbox's own, so the card says "You" and skips the actions that make no sense. */
export function isOwnAddress(address: string, ownAddresses: readonly string[]): boolean {
	const normalized = normalizeEmailAddress(address);
	return !!normalized && ownAddresses.some((own) => normalizeEmailAddress(own) === normalized);
}

/** What the hover tooltip of a participant says: the full address, then every other address of the person. */
export function participantTooltip(address: string, otherAddresses: readonly string[] = []): string | null {
	const shown = getEmailAddress(address).trim();
	if (!shown) return null;
	return otherAddresses.length > 0 ? `${shown}, also ${otherAddresses.join(", ")}` : shown;
}

/** What a person may do from the card, from the permission on the mailbox the message is in. */
export function contactCardAccess(permission: MailboxPermission | null | undefined): {
	canSend: boolean;
	canEdit: boolean;
} {
	return { canSend: !!permission && canSendFromMailbox(permission), canEdit: canManageMailboxMail(permission) };
}

/**
 * The mail search that lists what one address sent. The quoted whole address is matched exactly by the search
 * (`from:"hi@cursor.com"` never finds `x.hi@cursor.com`); the list applies it within its folder and mailbox scope.
 */
export function fromSearchQuery(address: string): string {
	return `from:"${getEmailAddress(address).trim()}"`;
}

/** The label of the search action: the name, or the address when the person has none. It searches the Inbox list. */
export function showMailFromLabel(name: string, address: string): string {
	return `Search Inbox for mail from ${name.trim() || getEmailAddress(address)}`;
}
