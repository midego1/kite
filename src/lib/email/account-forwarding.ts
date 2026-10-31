import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import { resolveInboundAddress } from "@/lib/email/routing";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("account-forwarding");

export const KITE_FORWARDED_HEADER = "X-Kite-Forwarded";
// The name installs from before the rename to Kite used. It counts only with this install's own signed value.
const LEGACY_FORWARDED_HEADER = "X-Mailflare-Forwarded";

/** The unsigned marker, written and accepted only by an install without any server secret. */
const UNSIGNED_MARKER = "1";
const MARKER_LABEL = "kite forwarded marker v1";

/** Reads one header field of the message, by name. */
type HeaderLookup = (name: string) => string | null | undefined;

/** The server secret the marker is derived from: APP_ENCRYPTION_KEY, else INBOUND_WEBHOOK_SECRET, else CF_TOKEN. */
function markerSecret(env: CloudflareEnv): string | null {
	for (const value of [env.APP_ENCRYPTION_KEY, env.INBOUND_WEBHOOK_SECRET, env.CF_TOKEN]) {
		const secret = value?.trim();
		if (secret) return secret;
	}
	return null;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function markerKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
		]);
		keyCache.set(secret, key);
	}
	return key;
}

/** The message's own Message-ID without angle brackets, or "" when it has none. */
function messageIdOf(header: HeaderLookup): string {
	return normalizeMessageId(header("Message-ID") ?? header("message-id")) ?? "";
}

/**
 * The loop-guard value Kite writes on a message it forwards (upstream Mailflare #223): `v1.` and an HMAC, keyed with a
 * server secret, over a label and the message's Message-ID. A sender cannot write it, so `X-Kite-Forwarded: 1` no
 * longer switches account forwarding off. Every forward target sees the value; because it is bound to the Message-ID,
 * a value copied from a forwarded message only matches mail carrying that same Message-ID. It is not bound to the
 * recipient, because a forward between two mailboxes of this install must still be recognised. Without any secret it
 * is the unsigned "1". Another Kite install has its own key, so two installs forwarding to each other stop after one
 * extra hop, when the mail comes back to the install that marked it.
 */
export async function forwardedMarker(env: CloudflareEnv, header: HeaderLookup): Promise<string> {
	const secret = markerSecret(env);
	if (!secret) return UNSIGNED_MARKER;
	const payload = new TextEncoder().encode(`${MARKER_LABEL}\n${messageIdOf(header)}`);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await markerKey(secret), payload));
	return `v1.${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sameValue(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

/**
 * True when this install already forwarded the message, so account forwarding must not loop it. Either header name
 * counts, but only with this install's own value for this message's Message-ID: a forward from another install added
 * a value of its own, and repeated fields arrive joined with commas, so each value is compared on its own.
 */
export async function wasForwardedByKite(env: CloudflareEnv, header: HeaderLookup): Promise<boolean> {
	const expected = await forwardedMarker(env, header);
	return [KITE_FORWARDED_HEADER, LEGACY_FORWARDED_HEADER].some((name) =>
		[header(name), header(name.toLowerCase())].some((value) =>
			(value ?? "").split(",").some((part) => sameValue(part.trim(), expected)),
		),
	);
}

/**
 * The account forwarding address for mail to `recipient`, or null. Never throws, like `resolveIncomingMail`: when the
 * database cannot be read the message is still stored (and not forwarded) instead of being refused.
 */
export async function getAccountForwardingDestination(env: CloudflareEnv, recipient: string): Promise<string | null> {
	try {
		return await accountForwardingDestination(env, recipient);
	} catch (error) {
		logger.error("email.account_forwarding_lookup_failed", { error });
		return null;
	}
}

async function accountForwardingDestination(env: CloudflareEnv, recipient: string): Promise<string | null> {
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	const destination = account?.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(recipient).toLowerCase()) {
		return null;
	}
	return destination;
}
