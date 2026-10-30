import { getEmailAddress, getEmailDisplayName, splitEmailAddressList } from "@/lib/email/address";
import { formatRecipientAddress, type RecipientAddressStyle } from "@/lib/email/recipient-display";
import type { ThreadMessage } from "@/hooks/types";

/** Messages on one side of the current one, in chronological order. */
export function partitionThread(
	messages: ThreadMessage[],
	currentMessageId: string,
	position: "before" | "after",
	latestMessagesFirst: boolean,
): ThreadMessage[] {
	const index = messages.findIndex((message) => message.id === currentMessageId);
	const slice =
		index < 0
			? position === "before"
				? messages
				: []
			: position === "before"
				? messages.slice(0, index)
				: messages.slice(index + 1);
	return latestMessagesFirst ? [...slice].reverse() : slice;
}

export function getConversationSender(message: ThreadMessage, currentAccountName?: string): string {
	if (message.direction === "outbound") return currentAccountName ?? getEmailDisplayName(message.fromAddr);
	return message.fromContactName ?? getEmailDisplayName(message.fromAddr);
}

export function getConversationSenderEmail(message: ThreadMessage): string {
	if (message.direction === "outbound") return getEmailAddress(message.fromAddr);
	return getEmailAddress(message.fromAddr);
}

/** Recipient summary for a thread card. Same address or full form as the open message. */
export function getConversationRecipients(message: ThreadMessage, style: RecipientAddressStyle = "address"): string {
	const names = [...splitEmailAddressList(message.toAddr), ...splitEmailAddressList(message.ccAddr)].map((entry) =>
		formatRecipientAddress(entry, style),
	);
	if (names.length === 0) return "";
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 3).join(", ")}, +${names.length - 3}`;
}

export function getAvatarInitial(message: ThreadMessage, currentAccountName?: string): string {
	const name = getConversationSender(message, currentAccountName) || getEmailAddress(message.fromAddr);
	return name.trim().charAt(0).toUpperCase() || "?";
}

export type ThreadParticipant = {
	name: string;
	address: string;
	/** Other addresses the same display name wrote from or was sent to in the conversation. */
	otherAddresses?: string[];
};

/**
 * The people of a conversation for the reader's chips: senders and recipients, once each, in order. A display
 * name that reappears with another address (a person writing from work and from home) stays one chip that
 * remembers the other addresses; a bare address never merges.
 */
export function getThreadParticipants(people: ThreadParticipant[]): ThreadParticipant[] {
	const seen = new Set<string>();
	const byName = new Map<string, ThreadParticipant>();
	const participants: ThreadParticipant[] = [];
	for (const person of people) {
		const address = person.address.trim();
		const name = person.name.trim() || address;
		const key = address.toLowerCase() || name.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const nameKey = address && name.toLowerCase() !== address.toLowerCase() ? name.toLowerCase() : "";
		const sameName = nameKey ? byName.get(nameKey) : undefined;
		if (sameName && address) {
			sameName.otherAddresses = [...(sameName.otherAddresses ?? []), address];
			continue;
		}
		const participant: ThreadParticipant = { name, address: person.address };
		participants.push(participant);
		if (nameKey) byName.set(nameKey, participant);
	}
	return participants;
}

/** The first and last dates of a conversation, or the one date when it all happened on a day. */
export function getThreadDateRange(dates: string[]): { first: string; last: string } | null {
	const sorted = dates.filter((date) => !Number.isNaN(Date.parse(date))).sort((a, b) => Date.parse(a) - Date.parse(b));
	if (sorted.length === 0) return null;
	return { first: sorted[0], last: sorted.at(-1)! };
}
