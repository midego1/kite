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
 * Why `account` cannot send as its address now, or null when it can. The login address is proven when it is the
 * sign-in user name (proving the password proves the address) at a known provider's own server; an "Other" provider's
 * server is the user's choice and may accept any address, and a user name that is not the address proves nothing
 * about it. An address that is not proven that way needs a verification code first (`addressVerified`, spec §7.2),
 * which is also what lets an account send as another address of its owner (an alias). Then the SMTP sign-in must
 * work with the saved password. `refusal` is the owner's connect refusal (install switch off, permission revoked, no
 * key): then nothing is sent, as nothing is synced.
 */
export function sendBlock(
	account: SendableAccount,
	refusal: ConnectRefusal | null,
	addressVerified = false,
): SendBlock | null {
	if (refusal) return "not_allowed";
	if (!account.smtpHost) return "no_smtp";
	if (!account.sendEnabled) return "send_off";
	if (!addressVerified) {
		if (account.username.trim().toLowerCase() !== account.address.trim().toLowerCase()) return "alias";
		if (account.preset === "other") return "unproven";
	}
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

/** Whether the address needs a verification code before it can be sent as (`alias` or `unproven`). */
export function needsCode(block: SendBlock | null): boolean {
	return block === "alias" || block === "unproven";
}

/** Blocks the From menu still lists (disabled, with what to do); the others leave the address out. */
const LISTED_BLOCKS = new Set<SendBlock>(["reconnect", "not_verified", "alias", "unproven"]);

export function listsIdentity(block: SendBlock | null): boolean {
	return block === null || LISTED_BLOCKS.has(block);
}

/** What the owner can do about a block, in plain words. */
export const SEND_BLOCK_TEXT: Record<SendBlock, string> = {
	not_allowed: "Connected accounts are not available to you right now.",
	no_smtp: "Add the account's SMTP server to send from it.",
	send_off: "Sending from this account is turned off in Settings → Connected accounts.",
	alias: "Verify this address with a code under Settings → Connected accounts to send from it.",
	unproven: "Verify this address with a code under Settings → Connected accounts to send from it.",
	reconnect: "Reconnect the account under Settings → Connected accounts.",
	paused: "The account is paused.",
	not_verified: "Test the connection under Settings → Connected accounts to send from this address.",
};

/** Whether `address` (any case, with or without a display name already stripped) is the account's own. */
export function sameAddress(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}
