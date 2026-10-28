import { normalizeMessageId } from "@/lib/email/thread-lookup";

/** The fallback key prefix of a message without a Message-ID. */
const SHA256_KEY_PREFIX = "import:sha256:";

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * How an imported message is recognised again (spec §4.3). `stored` goes into `messages.provider_message_id`: the
 * Message-ID as the message wrote it (with its angle brackets, as inbound rows store it), or
 * `import:sha256:<hex of the raw bytes>` when it has none, so a re-run, another folder or a changed UIDVALIDITY
 * finds it. `key` is the same identity without brackets, which is what duplicates are compared by.
 */
export async function importDedupeKey(
	messageId: string | null,
	raw: ArrayBuffer,
): Promise<{ stored: string; key: string }> {
	const normalized = normalizeMessageId(messageId);
	if (normalized) return { stored: messageId!.trim(), key: normalized };
	const key = `${SHA256_KEY_PREFIX}${await sha256Hex(raw)}`;
	return { stored: key, key };
}

/**
 * The `provider_message_id` values that mean `key`: with and without angle brackets, because inbound rows store
 * them and outbound rows (mail Kite sent) do not. A fallback key has one spelling.
 */
export function storedIdVariants(key: string): string[] {
	return key.startsWith(SHA256_KEY_PREFIX) ? [key] : [key, `<${key}>`];
}

/** The comparison key of a stored `provider_message_id`. */
export function dedupeKeyOfStored(value: string | null): string | null {
	return normalizeMessageId(value);
}
