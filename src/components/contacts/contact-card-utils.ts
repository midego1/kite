import { getEmailAddress, normalizeEmailAddress } from "@/lib/email/address";

/** Whether the address is one of the mailbox's own, so the card says "You" and skips the actions that make no sense. */
export function isOwnAddress(address: string, ownAddresses: readonly string[]): boolean {
	const normalized = normalizeEmailAddress(address);
	return !!normalized && ownAddresses.some((own) => normalizeEmailAddress(own) === normalized);
}

/** "+1 more address" / "+2 more addresses", or null when the person used only one. */
function moreAddressesLabel(count: number): string | null {
	if (count <= 0) return null;
	return `+${count} more ${count === 1 ? "address" : "addresses"}`;
}

/** What the hover tooltip of a participant says: the full address and how many others the person used. */
export function participantTooltip(address: string, otherAddresses: readonly string[] = []): string | null {
	const shown = getEmailAddress(address).trim();
	if (!shown) return null;
	const more = moreAddressesLabel(otherAddresses.length);
	return more ? `${shown} (${more})` : shown;
}

/** The mail search that lists everything a person sent; the folder list applies it within the selected mailbox. */
export function fromSearchQuery(address: string): string {
	return `from:${getEmailAddress(address).trim()}`;
}

/** The label of the search action: the name, or the address when the person has none. */
export function showMailFromLabel(name: string, address: string): string {
	return `Show all mail from ${name.trim() || getEmailAddress(address)}`;
}
