import type { ConnectRefusal, ExternalAccountPresetId, ExternalAccountStatus, SendBlock } from "./types";

/** What decides whether an account's address may be sent as (spec §7.2). */
export type SendableAccount = {
	address: string;
	username: string;
	preset: ExternalAccountPresetId;
	status: ExternalAccountStatus;
	smtpHost: string | null;
	sendEnabled: boolean;
	hasPassword: boolean;
	smtpVerifiedAt: Date | null;
};

/**
 * Why `account`'s address cannot be sent as now, or null when it can. The login address is an identity only when it
 * is the sign-in user name (proving the password proves the address) and the SMTP sign-in succeeded with the saved
 * password at a known provider's own server; any other address waits for a verification code (PR 11). An "Other"
 * provider's address is never proven by its sign-in: the user chose the server, which may accept any address, so it is
 * not sent as until it is verified the same way. `refusal` is the owner's connect refusal
 * (install switch off, permission revoked, no key): then nothing is sent, as nothing is synced.
 */
export function sendBlock(account: SendableAccount, refusal: ConnectRefusal | null): SendBlock | null {
	if (refusal) return "not_allowed";
	if (!account.smtpHost) return "no_smtp";
	if (!account.sendEnabled) return "send_off";
	if (account.username.trim().toLowerCase() !== account.address.trim().toLowerCase()) return "alias";
	if (account.preset === "other") return "unproven";
	if (
		!account.hasPassword ||
		account.status === "auth_failed" ||
		account.status === "tls_failed" ||
		account.status === "disabled"
	)
		return "reconnect";
	if (account.status === "paused") return "paused";
	if (!account.smtpVerifiedAt) return "not_verified";
	return null;
}

/** Blocks the From menu still lists (disabled, with what to do); the others leave the address out. */
const LISTED_BLOCKS = new Set<SendBlock>(["reconnect", "not_verified"]);

export function listsIdentity(block: SendBlock | null): boolean {
	return block === null || LISTED_BLOCKS.has(block);
}

/** What the owner can do about a block, in plain words. */
export const SEND_BLOCK_TEXT: Record<SendBlock, string> = {
	not_allowed: "Connected accounts are not available to you right now.",
	no_smtp: "Add the account's SMTP server to send from it.",
	send_off: "Sending from this account is turned off in Settings → Connected accounts.",
	alias: "Kite sends only from the address the account signs in with.",
	unproven:
		"Kite cannot prove an address at a server you entered yourself, so it does not send from it until the address can be verified with a code.",
	reconnect: "Reconnect the account under Settings → Connected accounts.",
	paused: "The account is paused.",
	not_verified: "Test the connection under Settings → Connected accounts to send from this address.",
};

/** Whether `address` (any case, with or without a display name already stripped) is the account's own. */
export function sameAddress(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}
