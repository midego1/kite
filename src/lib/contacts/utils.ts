import type { ContactDisplayName } from "@/lib/contacts/types";
import { getEmailDisplayName, normalizeEmailAddress, parseEmailAddressParts } from "@/lib/email/address";

export function getContactId(userId: string, email: string): string {
	return `${userId}:${email.trim().toLowerCase()}`;
}

export function getContactNameFromAddress(address: string): string | null {
	const name = parseEmailAddressParts(address).name?.trim();
	if (!name) return null;
	return name === normalizeEmailAddress(address) ? null : name;
}

export function getDisplayNameForAddress(address: string, contactName?: string | null): string {
	return contactName?.trim() || getEmailDisplayName(address);
}

/**
 * The label of one party of a message, sender or recipient (upstream Mailflare #226, #266): a name the user set on
 * the contact wins, then the message's own header name, then a name learned from earlier mail, else null (the caller
 * shows the address). A shared address such as a recruiting no-reply carries a different name on every message, so
 * the header must beat whatever name the contact last learned.
 */
export function getPartyDisplayName(address: string, contact?: ContactDisplayName | null): string | null {
	const contactName = contact?.displayName.trim() || null;
	if (contact?.source === "manual" && contactName) return contactName;
	return getContactNameFromAddress(address) ?? contactName;
}
