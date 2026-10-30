import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { contacts, routingRules } from "@/db/schema";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import type { BlockContactInput, ContactDisplayName, ContactInput, MessageContactNames } from "@/lib/contacts/types";
import { getContactId, getContactNameFromAddress, getSenderDisplayName } from "@/lib/contacts/utils";
import { importGravatarAvatar } from "@/lib/contacts/gravatar";

export async function upsertContactFromAddress(env: CloudflareEnv, input: ContactInput) {
	const email = normalizeEmailAddress(input.address);
	if (!email) return null;

	const displayName = getContactNameFromAddress(input.address);
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)))
		.limit(1);
	const now = new Date();

	if (existing) {
		const nextDisplayName = getNextDisplayName(existing.displayName, existing.source, displayName, input.source);
		const nextSource =
			existing.source === "manual" || (existing.source === "outbound" && input.source === "inbound")
				? existing.source
				: input.source;

		await db
			.update(contacts)
			.set({
				displayName: nextDisplayName,
				source: nextSource,
				lastSeenAt: now,
			})
			.where(eq(contacts.id, existing.id));
		return { ...existing, displayName: nextDisplayName, source: nextSource, lastSeenAt: now };
	}

	const id = getContactId(input.userId, email);
	// Two first messages from one sender delivered at once both get here; the one that loses the race keeps the row
	// the other wrote instead of failing its delivery.
	const inserted = await db
		.insert(contacts)
		.values({
			id,
			userId: input.userId,
			email,
			displayName,
			source: input.source,
			lastSeenAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: contacts.id });
	// A sender filed as spam, trash or held by the Screener is not announced to Gravatar (upstream Mailflare #220).
	if (inserted.length && input.lookupAvatar !== false) {
		const avatarKey = await importGravatarAvatar(env, input.userId, email);
		if (avatarKey) {
			await db.update(contacts).set({ avatarKey }).where(eq(contacts.id, id));
		}
	}

	const [created] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)))
		.limit(1);
	return created ?? null;
}

export async function getContactDisplayNameMap(env: CloudflareEnv, userId: string, addresses: string[]) {
	const emails = Array.from(new Set(addresses.map(normalizeEmailAddress).filter(Boolean)));
	if (emails.length === 0) return new Map<string, ContactDisplayName>();

	const db = getDb(env);
	const rows = await queryInChunks(emails, (chunk) =>
		db
			.select({ email: contacts.email, displayName: contacts.displayName, source: contacts.source })
			.from(contacts)
			.where(and(eq(contacts.userId, userId), inArray(contacts.email, chunk))),
	);

	return new Map(
		rows
			.filter((contact) => !!contact.displayName)
			.map((contact): [string, ContactDisplayName] => [
				contact.email,
				{ displayName: contact.displayName!, source: contact.source },
			]),
	);
}

export async function getContactAvatarMap(env: CloudflareEnv, userId: string, addresses: string[]) {
	const emails = Array.from(new Set(addresses.map(normalizeEmailAddress).filter(Boolean)));
	if (emails.length === 0) return new Map<string, boolean>();

	const db = getDb(env);
	const rows = await queryInChunks(emails, (chunk) =>
		db
			.select({ email: contacts.email, avatarKey: contacts.avatarKey })
			.from(contacts)
			.where(and(eq(contacts.userId, userId), inArray(contacts.email, chunk))),
	);

	return new Map(rows.map((contact) => [contact.email, !!contact.avatarKey]));
}

export async function getMessageContactNames(
	env: CloudflareEnv,
	userId: string,
	fromAddr: string,
	toAddr: string,
): Promise<MessageContactNames> {
	// `toAddr` may be a full recipient list; the name shown belongs to the first one.
	const firstTo = getFirstEmailAddressEntry(toAddr);
	const contactMap = await getContactDisplayNameMap(env, userId, [fromAddr, firstTo]);

	return {
		fromContactName: getSenderDisplayName(fromAddr, contactMap.get(normalizeEmailAddress(fromAddr))),
		toContactName: contactMap.get(normalizeEmailAddress(firstTo))?.displayName ?? null,
	};
}

export async function blockContact(env: CloudflareEnv, input: BlockContactInput) {
	const email = normalizeEmailAddress(input.address);
	if (!email) throw new Error("Contact email is required");

	const db = getDb(env);
	const contactId = getContactId(input.userId, email);
	const [existingContact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)))
		.limit(1);
	if (existingContact) {
		await db.update(contacts).set({ blocked: true }).where(eq(contacts.id, existingContact.id));
	} else {
		await db.insert(contacts).values({
			id: contactId,
			userId: input.userId,
			email,
			displayName: getContactNameFromAddress(input.address),
			source: "inbound",
			blocked: true,
			lastSeenAt: new Date(),
		});
		const avatarKey = await importGravatarAvatar(env, input.userId, email);
		if (avatarKey) {
			await db.update(contacts).set({ avatarKey }).where(eq(contacts.id, contactId));
		}
	}

	const [existingRule] = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.matchField, "email"),
				eq(routingRules.matchOperator, "exact"),
				eq(routingRules.matchValue, email),
				eq(routingRules.action, "trash"),
			),
		)
		.limit(1);
	if (!existingRule) {
		await db.insert(routingRules).values({
			id: `block:${input.mailboxId}:${email}`,
			userId: input.userId,
			domainId: input.domainId,
			pattern: email,
			matchField: "email",
			matchOperator: "exact",
			matchValue: email,
			mailboxId: input.mailboxId,
			action: "trash",
			priority: 100,
		});
	}

	return { email, blocked: true };
}

/**
 * Lifts the block `blockContact` placed for one mailbox. The contact itself stays blocked while another
 * mailbox of the same owner still has its own block rule for the address. `removeRule: false` keeps the
 * mailbox's rule (it was not this caller's to remove) and `clearContact: false` keeps the contact's flag
 * (it was set before this caller's block).
 */
export async function unblockContact(
	env: CloudflareEnv,
	input: Omit<BlockContactInput, "domainId">,
	options: { removeRule?: boolean; clearContact?: boolean } = {},
) {
	const email = normalizeEmailAddress(input.address);
	if (!email) return { email, blocked: false };
	const db = getDb(env);
	if (options.removeRule !== false)
		await db.delete(routingRules).where(eq(routingRules.id, `block:${input.mailboxId}:${email}`));
	const [remaining] = await db
		.select({ id: routingRules.id })
		.from(routingRules)
		.where(
			and(
				eq(routingRules.userId, input.userId),
				eq(routingRules.matchField, "email"),
				eq(routingRules.matchOperator, "exact"),
				eq(routingRules.matchValue, email),
				eq(routingRules.action, "trash"),
			),
		)
		.limit(1);
	if (!remaining && options.clearContact !== false)
		await db
			.update(contacts)
			.set({ blocked: false })
			.where(and(eq(contacts.userId, input.userId), eq(contacts.email, email)));
	return { email, blocked: !!remaining };
}

function getNextDisplayName(
	existingName: string | null,
	source: string,
	nextName: string | null,
	incomingSource: string,
): string | null {
	if (source === "manual") return existingName;
	// A sender chooses its own From name, so inbound mail may name a contact but never rename one (upstream #223).
	if (incomingSource === "inbound" && existingName) return existingName;
	if (nextName) return nextName;
	return existingName;
}
