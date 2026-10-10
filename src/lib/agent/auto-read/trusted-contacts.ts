import { and, asc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { contacts } from "@/db/schema";
import { findSpoofedContact, normalizeDisplayName } from "./facts-utils";
import type { FactsContact } from "./facts-types";

const DISPLAY_NAME_PAGE = 500;

const contactColumns = {
	id: contacts.id,
	email: contacts.email,
	displayName: contacts.displayName,
	source: contacts.source,
};

/** Manual and outbound contacts of the mailbox owner, the namespace mailbox contacts are kept in. */
function trustedOf(ownerUserId: string) {
	return and(eq(contacts.userId, ownerUserId), ne(contacts.source, "inbound"));
}

async function addressMatches(db: AppDatabase, ownerUserId: string, addresses: string[]) {
	if (!addresses.length) return [];
	return db
		.select(contactColumns)
		.from(contacts)
		.where(and(trustedOf(ownerUserId), inArray(sql`lower(trim(${contacts.email}))`, addresses)));
}

/**
 * Pages through every named contact until one matches. Display names are compared after Unicode
 * normalization and case folding, which SQLite's ASCII-only lower() cannot express in a filter.
 */
async function displayNameMatch(db: AppDatabase, ownerUserId: string, senderAddress: string, senderName: string) {
	let after = "";
	for (;;) {
		const page = await db
			.select(contactColumns)
			.from(contacts)
			.where(and(trustedOf(ownerUserId), isNotNull(contacts.displayName), gt(contacts.id, after)))
			.orderBy(asc(contacts.id))
			.limit(DISPLAY_NAME_PAGE);
		const spoofed = findSpoofedContact(senderAddress, senderName, page);
		if (spoofed) return page.filter((contact) => contact.email.trim().toLowerCase() === spoofed).slice(0, 1);
		if (page.length < DISPLAY_NAME_PAGE) return [];
		after = page[page.length - 1].id;
	}
}

/**
 * The owner's trusted contacts that can affect the sender's facts: the sender's own contact, a
 * contact whose address is used as the display name, and the first contact sharing the display name.
 */
export async function loadTrustedContacts(
	db: AppDatabase,
	ownerUserId: string,
	sender: { address: string; name: string | null },
): Promise<FactsContact[]> {
	const name = normalizeDisplayName(sender.name);
	const [byAddress, byName] = await Promise.all([
		addressMatches(db, ownerUserId, [...new Set([sender.address, name].filter(Boolean))]),
		name ? displayNameMatch(db, ownerUserId, sender.address, sender.name ?? "") : [],
	]);
	return [...byAddress, ...byName].map(({ email, displayName, source }) => ({ email, displayName, source }));
}
