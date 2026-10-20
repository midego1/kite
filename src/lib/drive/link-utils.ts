export const DRIVE_LINK_MAX_DAYS_LIMIT = 365;
export const DRIVE_LINK_DEFAULT_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an unlocked password link stays open in one browser. */
export const DRIVE_UNLOCK_TTL_SECONDS = 60 * 60;
export const DRIVE_LINK_PASSWORD_MAX_LENGTH = 200;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: the secret part of `/d/<token>`. */
export function generateLinkToken(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What `drive_links.token_hash` stores and what a visitor's token is compared by. */
export async function hashLinkToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return base64Url(new Uint8Array(digest));
}

/** Tokens are exactly 43 base64url characters; anything else is answered with the same 404 without a lookup. */
export function isWellFormedLinkToken(token: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * The expiry for a link valid `days` days from `now`, or the reason it cannot have one. Every link expires:
 * `days` is required and bounded by the install's `link_max_days`, where 0 turns links off.
 */
export function linkExpiry(days: unknown, maxDays: number, now: Date): Date | { error: string; status: number } {
	if (maxDays <= 0) return { error: "Public links are turned off", status: 403 };
	if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > maxDays)
		return { error: `Choose an expiry from 1 to ${maxDays} days`, status: 400 };
	return new Date(now.getTime() + days * DAY_MS);
}

export function isLinkActive(link: { expiresAt: Date; revokedAt: Date | null }, now: Date): boolean {
	return !link.revokedAt && link.expiresAt.getTime() > now.getTime();
}

/** A link password from a request body: undefined for none, null when it is unusable. */
export function parseLinkPassword(value: unknown): string | null | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > DRIVE_LINK_PASSWORD_MAX_LENGTH) return null;
	return value;
}

export function unlockCookieName(linkId: string): string {
	return `kite_link_${linkId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * The key that signs a link's unlock cookie, derived from its password hash: a visitor never sees the
 * hash, and changing or removing the password ends every unlocked session.
 */
async function unlockKey(passwordHash: string): Promise<CryptoKey> {
	const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kite-drive-unlock:${passwordHash}`));
	return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(passwordHash: string, payload: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await unlockKey(passwordHash), new TextEncoder().encode(payload));
	return base64Url(new Uint8Array(signature));
}

/** `<expiresAtSeconds>.<hmac(linkId.expires)>`; the cookie lives no longer than the link. */
export async function createUnlockValue(
	link: { id: string; passwordHash: string; expiresAt: Date },
	now: Date,
): Promise<{ value: string; maxAge: number }> {
	const until = Math.min(
		Math.floor(now.getTime() / 1000) + DRIVE_UNLOCK_TTL_SECONDS,
		Math.floor(link.expiresAt.getTime() / 1000),
	);
	const maxAge = Math.max(until - Math.floor(now.getTime() / 1000), 0);
	return { value: `${until}.${await sign(link.passwordHash, `${link.id}.${until}`)}`, maxAge };
}

export async function verifyUnlockValue(
	link: { id: string; passwordHash: string },
	value: string | undefined,
	now: Date,
): Promise<boolean> {
	const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
	if (!match) return false;
	const until = Number(match[1]);
	if (until * 1000 <= now.getTime()) return false;
	const expected = await sign(link.passwordHash, `${link.id}.${until}`);
	return timingSafeEqual(expected, match[2]);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** The value of one cookie from a Cookie header. */
export function readCookie(header: string | null, name: string): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

/**
 * The `Set-Cookie` value for an unlocked link: readable only by the link's own API paths, never by script,
 * and never sent from another site.
 */
export function unlockCookieHeader(
	linkId: string,
	token: string,
	unlock: { value: string; maxAge: number },
	secure: boolean,
): string {
	const parts = [
		`${unlockCookieName(linkId)}=${unlock.value}`,
		`Max-Age=${unlock.maxAge}`,
		`Path=/api/public/drive/${token}`,
		"HttpOnly",
		"SameSite=Strict",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}
