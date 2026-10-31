import { timingSafeEqual } from "@/lib/auth/totp";

/** How long a mailed code can be entered (spec §7.2). */
export const IDENTITY_CODE_TTL_MS = 30 * 60_000;

/** Wrong codes accepted for one code before it is dropped and a new one is needed. */
export const MAX_CODE_ATTEMPTS = 5;

/** Addresses one account can hold besides the ones its sign-in proves. */
export const MAX_IDENTITIES_PER_ACCOUNT = 10;

/**
 * Code mails per user an hour (every request), per user and address an hour, and per address a day whoever asks: the
 * form cannot be used to mail anyone, and one user cannot hold another's address at its limit.
 */
export const CODES_PER_USER = 5;
export const CODES_PER_ADDRESS = 3;
export const CODES_PER_ADDRESS_PER_DAY = 10;
export const CODE_WINDOW_MS = 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

/** Wrong codes an address may collect in a day, over all its codes; then it gets no new code or try until tomorrow. */
export const MAX_FAILED_CODES_PER_DAY = 10;

/**
 * One address and nothing else: no display name, list, comment, quoting or line break can reach the To of the code
 * mail, so the only recipient is the address being verified.
 */
const ADDRESS =
	/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The address of an add request, lower-case, or null when it is not one plain address. */
export function parseIdentityAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const address = value.trim().toLowerCase();
	if (address.length > 254 || !ADDRESS.test(address)) return null;
	if (address.startsWith(".") || address.includes("..") || address.split("@")[0].endsWith(".")) return null;
	return address;
}

/** A display name for From, or null; at most 200 characters, never a line break. */
export function parseIdentityName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.replace(/[\r\n\t]+/g, " ").trim();
	return name ? name.slice(0, 200) : null;
}

/**
 * Six random digits, every value equally likely: 32-bit draws above the largest multiple of a million are thrown away
 * instead of folded, so no code is likelier than another.
 */
export function generateIdentityCode(random: (bytes: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)) {
	const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
	const draw = new Uint32Array(1);
	for (;;) {
		const [value] = random(draw);
		if (value < limit) return String(value % 1_000_000).padStart(6, "0");
	}
}

/** The code as typed, without spaces or dashes, or null when it is not six digits. */
export function normalizeIdentityCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const digits = value.replace(/[\s-]/g, "");
	return /^\d{6}$/.test(digits) ? digits : null;
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * What `code_hash` stores: an HMAC-SHA256 of the identity's id and the code, keyed by APP_ENCRYPTION_KEY (connected
 * accounts need it). A plain hash of six digits is undone by trying all million; without the key the column is useless,
 * and the id binds a code to the one address it was mailed to.
 */
export async function hashIdentityCode(secret: string, identityId: string, code: string): Promise<string> {
	if (!secret) throw new Error("APP_ENCRYPTION_KEY is required for verification codes");
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(`kite.external-identity-code.v1:${secret}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${identityId}:${code}`)));
}

/** Compares two stored hashes in constant time. */
export function sameCodeHash(expected: string, candidate: string): boolean {
	return timingSafeEqual(expected, candidate);
}

/** Where an address stands: usable, waiting for a code that can still be entered, or needing a (new) code. */
export function identityState(
	row: { verifiedAt: Date | null; codeHash: string | null; codeExpiresAt: Date | null },
	now = new Date(),
): "verified" | "pending" | "unverified" {
	if (row.verifiedAt) return "verified";
	if (row.codeHash && row.codeExpiresAt && row.codeExpiresAt.getTime() > now.getTime()) return "pending";
	return "unverified";
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The code mail: a fixed text with the code and the address it confirms. Nothing the requester typed but the address
 * itself (checked by `parseIdentityAddress`) appears in it, so it cannot carry anyone's message.
 */
export function identityCodeMail(address: string, code: string): { subject: string; text: string; html: string } {
	const minutes = IDENTITY_CODE_TTL_MS / 60_000;
	const subject = "Your Kite verification code";
	const lines = [
		`Your verification code is ${code}.`,
		"",
		`Someone asked to send mail as ${address} from Kite. Enter this code in Kite, under Settings → Connected accounts, to allow it. The code works for ${minutes} minutes.`,
		"",
		"If this was not you, ignore this message: nobody can send as this address from Kite without the code.",
	];
	const html = [
		`<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p>`,
		`<p>Someone asked to send mail as ${escapeHtml(address)} from Kite. Enter this code in Kite, under Settings → Connected accounts, to allow it. The code works for ${minutes} minutes.</p>`,
		"<p>If this was not you, ignore this message: nobody can send as this address from Kite without the code.</p>",
	].join("\n");
	return { subject, text: lines.join("\n"), html };
}
