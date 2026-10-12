import { parseActionState } from "./actions-utils";

/** Mirrors the settings schema limit; muted senders are never evicted, so a full list stops growing. */
const MAX_MUTED_SENDERS = 500;

function mutedList(record: Record<string, unknown>): string[] {
	if (!Array.isArray(record.mutedSenders)) return [];
	const senders = record.mutedSenders
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(senders)];
}

/**
 * The capabilities JSON with the sender added to or removed from `mutedSenders`, keeping every other
 * key as stored. Null when nothing changes: the sender is empty, already in the wanted state, or the
 * list is full.
 */
export function applyMutedSenderChange(
	capabilities: string | null,
	sender: string,
	change: "add" | "remove",
): string | null {
	const address = sender.trim().toLowerCase();
	if (!address) return null;
	const record = parseActionState(capabilities) ?? {};
	const current = mutedList(record);
	const muted = current.includes(address);
	if (change === "add" && (muted || current.length >= MAX_MUTED_SENDERS)) return null;
	if (change === "remove" && !muted) return null;
	const next = change === "add" ? [...current, address] : current.filter((value) => value !== address);
	return JSON.stringify({ ...record, mutedSenders: next });
}
