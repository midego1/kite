import { getDb } from "@/db";
import { parseEmailAddressParts } from "@/lib/email/address";
import { findSpoofedContact } from "@/lib/agent/auto-read/facts-utils";
import { loadTrustedContacts } from "@/lib/agent/auto-read/trusted-contacts";

/**
 * A trusted contact (manually saved, or someone the owner has sent mail to) whose display name
 * this message's From header reuses with a different address. Reads the same bounded, paginated
 * contact lookup automatic reading already uses for every triaged message (`loadTrustedContacts`,
 * `findSpoofedContact`) — not a new check, just reused for the reader. `null` when the message has
 * no display name to compare, or it matches no trusted contact.
 */
export async function findSpoofedSenderContact(
	env: CloudflareEnv,
	userId: string,
	fromAddr: string,
): Promise<string | null> {
	const { name, address } = parseEmailAddressParts(fromAddr);
	if (!name) return null;
	const normalizedAddress = address.trim().toLowerCase();
	const db = getDb(env);
	const trusted = await loadTrustedContacts(db, userId, { address: normalizedAddress, name });
	return findSpoofedContact(normalizedAddress, name, trusted);
}
