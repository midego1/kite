import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { canOffloadHtmlBodies, putOffloadedHtmlBody, recordOffloadedHtmlBody } from "@/lib/email/bodies";
import { planHtmlBodyOffload } from "@/lib/email/bodies-utils";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import type { ParsedEmail } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { dedupeKeyOfStored, importDedupeKey, storedIdVariants } from "./dedupe-utils";
import { importMessageDate } from "./date-utils";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import { applyImportHints, getImportMessageHints } from "./message-hints-utils";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
		/**
		 * Uploaded files carry their state in their headers (`Status`, `X-Gmail-Labels`, `X-Spam-Flag`): read it for
		 * messages without source flags and let it move Inbox uploads to spam or trash. IMAP and module imports leave
		 * it off.
		 */
		headerHints?: boolean;
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	const db = getDb(env);
	const parsedMessages: ParsedImport[] = [];
	for (const message of input.messages) {
		try {
			const parsed = await parseRawMime(message.raw);
			const identity = await importDedupeKey(parsed.messageId, message.raw);
			const hints = input.headerHints ? getImportMessageHints(message.raw) : {};
			parsedMessages.push({
				...message,
				read: message.read ?? hints.read,
				starred: message.starred ?? hints.starred,
				destination: applyImportHints(input.destination, hints),
				parsed,
				providerMessageId: identity.stored,
				dedupeKey: identity.key,
			});
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}

	// One lookup per batch instead of one per message.
	const offloadBodies = await canOffloadHtmlBodies(env);
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
				message,
				offloadBodies,
			});
			result.imported += 1;
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

type ParsedImport = ImportMessageInput & {
	/** Where this message goes: the batch's destination, unless its own headers refine it. */
	destination: ImportDestination;
	parsed: ParsedEmail;
	providerMessageId: string;
	dedupeKey: string;
};

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
		message: ParsedImport;
		offloadBodies: boolean;
	},
): Promise<void> {
	const { parsed, providerMessageId, raw, read, starred, receivedAt } = input.message;
	const db = getDb(env);
	const messageId = newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	// The Date header first, the source's INTERNALDATE when it has none (or none that parses); never far in the future.
	const createdAt = importMessageDate([parsed.date, receivedAt], new Date());
	const placement = getImportMessagePlacement(input.message.destination);
	// A large HTML body goes to the Mail store; the row keeps a text body for search and snippets. The object is
	// written first and the row is inserted with its key in one batch, so a failure at any step leaves at most an
	// orphan object, never a row whose HTML is missing.
	const offload = input.offloadBodies ? planHtmlBodyOffload(messageId, parsed) : null;
	if (offload) await putOffloadedHtmlBody(env, offload);

	const insert = db.insert(messages).values({
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
		textBody: offload ? offload.textBody : parsed.text,
		htmlBody: offload ? null : parsed.html,
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
		await (offload ? db.batch([insert, recordOffloadedHtmlBody(db, messageId, offload)]) : insert);
	} catch (error) {
		if (offload) await env.BUCKET.delete(offload.key).catch(() => undefined);
		throw error;
	}

	const contactAddress = placement.direction === "outbound" ? toAddr : fromAddr;
	// Independent writes, run together; every one settles before a failure cleans up, so none lands afterwards.
	const writes = await Promise.allSettled([
		env.BUCKET.put(rawR2Key, raw, {
			httpMetadata: { contentType: "message/rfc822" },
		}),
		// Verified attachments are served from the raw written beside them; a failed write of either removes the message.
		storeMessageAttachments(env, messageId, parsed.attachments, {
			validate: false,
			raw: { key: rawR2Key, bytes: raw, status: placement.status },
		}),
		// A spammer does not become a contact (and is not looked up on Gravatar).
		placement.status === "spam"
			? null
			: upsertContactFromAddress(env, {
					userId: input.userId,
					address: contactAddress,
					source: placement.direction === "outbound" ? "outbound" : "inbound",
				}),
	]);
	const failed = writes.find((write) => write.status === "rejected");
	if (failed) {
		await deleteMessageWithObjects(env, db, messageId, rawR2Key);
		throw failed.reason;
	}
}
