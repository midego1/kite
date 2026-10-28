import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import type { ParsedEmail } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { dedupeKeyOfStored, importDedupeKey, storedIdVariants } from "./dedupe-utils";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	const db = getDb(env);
	const parsedMessages: ParsedImport[] = [];
	for (const message of input.messages) {
		try {
			const parsed = await parseRawMime(message.raw);
			const identity = await importDedupeKey(parsed.messageId, message.raw);
			parsedMessages.push({ ...message, parsed, providerMessageId: identity.stored, dedupeKey: identity.key });
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}

	// One lookup per batch instead of one per message.
	const existing = await findExistingDedupeKeys(
		db,
		input.mailboxId,
		parsedMessages.map((message) => message.dedupeKey),
	);
	for (const message of parsedMessages) {
		if (existing.has(message.dedupeKey)) {
			result.skipped += 1;
			continue;
		}
		existing.add(message.dedupeKey);
		try {
			await importParsedMessage(env, {
				userId: input.userId,
				mailboxId: input.mailboxId,
				destination: input.destination,
				message,
			});
			result.imported += 1;
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

type ParsedImport = ImportMessageInput & { parsed: ParsedEmail; providerMessageId: string; dedupeKey: string };

/** The dedupe keys of `keys` the mailbox already holds, whichever spelling (brackets or not) a row stored. */
async function findExistingDedupeKeys(
	db: ReturnType<typeof getDb>,
	mailboxId: string,
	keys: string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	const variants = Array.from(new Set(keys)).flatMap(storedIdVariants);
	// D1 allows 100 bound parameters per query.
	for (let index = 0; index < variants.length; index += 90) {
		const rows = await db
			.select({ providerMessageId: messages.providerMessageId })
			.from(messages)
			.where(
				and(eq(messages.mailboxId, mailboxId), inArray(messages.providerMessageId, variants.slice(index, index + 90))),
			);
		for (const row of rows) {
			const key = dedupeKeyOfStored(row.providerMessageId);
			if (key) found.add(key);
		}
	}
	return found;
}

async function importParsedMessage(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		message: ParsedImport;
	},
): Promise<void> {
	const { parsed, providerMessageId, raw, read, starred, receivedAt } = input.message;
	const db = getDb(env);
	const messageId = newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	// The Date header first; the source's INTERNALDATE when it has none (or none that parses).
	const createdAt = parsed.date ?? receivedAt ?? new Date();
	const placement = getImportMessagePlacement(input.destination);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: input.mailboxId,
		folderId: placement.folderId,
		direction: placement.direction,
		providerMessageId,
		fromAddr,
		toAddr,
		ccAddr: parsed.ccAddr,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key,
		status: placement.status,
		read: placement.direction === "outbound" || read === true,
		starred: starred === true,
		threadId: await resolveThreadId(db, {
			mailboxId: input.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
			// Imports run newest first, so a reply often arrives before its parent (spec §4.4).
			fallback: "references-root",
		}),
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		createdAt,
	});

	try {
		const contactAddress = placement.direction === "outbound" ? toAddr : fromAddr;
		// Independent writes; run them together instead of one after another.
		await Promise.all([
			env.BUCKET.put(rawR2Key, raw, {
				httpMetadata: { contentType: "message/rfc822" },
			}),
			storeMessageAttachments(env, messageId, parsed.attachments, { validate: false }),
			upsertContactFromAddress(env, {
				userId: input.userId,
				address: contactAddress,
				source: placement.direction === "outbound" ? "outbound" : "inbound",
			}),
		]);
	} catch (error) {
		await deleteMessageWithObjects(env, db, messageId, rawR2Key);
		throw error;
	}
}
