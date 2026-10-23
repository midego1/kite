/** Listed senders are never evicted, so a full list stops growing. */
export const MAX_LISTED_SENDERS = 500;
const MAX_ADDRESS_LENGTH = 320;
const ADDRESS = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]+$/;

export type SenderListName = "trusted" | "muted";

/** The `capabilities` key each list is stored under. */
export const SENDER_LIST_FIELDS = { trusted: "trustedSenders", muted: "mutedSenders" } as const;

export type SenderListEdit = { mailboxId: string; list: SenderListName; change: "add" | "remove"; sender: string };

function normalizeSenderAddress(value: string): string {
	return value.trim().toLowerCase();
}

/** Null for a plain address such as `name@example.com`, otherwise what is wrong with the input. */
export function senderAddressError(value: string): string | null {
	const address = normalizeSenderAddress(value);
	if (!address) return "Enter an email address";
	if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(address))
		return "Enter one email address, like name@example.com";
	return null;
}

/**
 * The edit a request body asks for, or an error message: exactly one of `add` and `remove`. Only an
 * added address must look like one, so an odd entry stored earlier can still be removed.
 */
export function parseSenderListEdit(body: unknown): SenderListEdit | string {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid request";
	const { mailboxId, list, add, remove } = body as Record<string, unknown>;
	if (typeof mailboxId !== "string" || !mailboxId) return "Mailbox required";
	if (list !== "trusted" && list !== "muted") return "Choose the trusted or the muted senders";
	if ((add === undefined) === (remove === undefined)) return "Send either add or remove";
	const change = add === undefined ? "remove" : "add";
	const value = add ?? remove;
	if (typeof value !== "string" || !normalizeSenderAddress(value) || value.length > MAX_ADDRESS_LENGTH)
		return "Enter an email address";
	const problem = change === "add" ? senderAddressError(value) : null;
	if (problem) return problem;
	return { mailboxId, list, change, sender: normalizeSenderAddress(value) };
}
