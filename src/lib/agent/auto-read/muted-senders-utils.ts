import { parseActionState } from "./actions-utils";
import { MAX_LISTED_SENDERS } from "./sender-lists-utils";

export type SenderList = "mutedSenders" | "trustedSenders";

function senderList(record: Record<string, unknown>, list: SenderList): string[] {
	const values = record[list];
	if (!Array.isArray(values)) return [];
	const senders = values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(senders)];
}

/**
 * The capabilities JSON with the sender added to or removed from `mutedSenders` (or the other named
 * list), keeping every other key as stored. Null when nothing changes: the sender is empty, already
 * in the wanted state, or the list is full.
 */
export function applyMutedSenderChange(
	capabilities: string | null,
	sender: string,
	change: "add" | "remove",
	list: SenderList = "mutedSenders",
): string | null {
	const address = sender.trim().toLowerCase();
	if (!address) return null;
	const record = parseActionState(capabilities) ?? {};
	const current = senderList(record, list);
	const listed = current.includes(address);
	if (change === "add" && (listed || current.length >= MAX_LISTED_SENDERS)) return null;
	if (change === "remove" && !listed) return null;
	const next = change === "add" ? [...current, address] : current.filter((value) => value !== address);
	return JSON.stringify({ ...record, [list]: next });
}
