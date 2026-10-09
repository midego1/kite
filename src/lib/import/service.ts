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
			parsedMessages.push({
				...message,
				parsed,
				providerMessageId: parsed.messageId ?? `import:${message.filename}:${message.raw.byteLength}`,
			});
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}

	// One lookup per batch instead of one per message.
	const existing = await findExistingProviderMessageIds(
		db,
		input.mailboxId,
		parsedMessages.map((message) => message.providerMessageId),
	);
	for (const message of parsedMessages) {
		if (existing.has(message.providerMessageId)) {
			result.skipped += 1;
			continue;
		}
		existing.add(message.providerMessageId);
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

type ParsedImport = ImportMessageInput & { parsed: ParsedEmail; providerMessageId: string };

async function findExistingProviderMessageIds(
	db: ReturnType<typeof getDb>,
	mailboxId: string,
	providerMessageIds: string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	const unique = Array.from(new Set(providerMessageIds));
	// D1 allows 100 bound parameters per query.
	for (let index = 0; index < unique.length; index += 90) {
		const rows = await db
			.select({ providerMessageId: messages.providerMessageId })
			.from(messages)
			.where(
				and(eq(messages.mailboxId, mailboxId), inArray(messages.providerMessageId, unique.slice(index, index + 90))),
			);
		for (const row of rows) if (row.providerMessageId) found.add(row.providerMessageId);
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
	const { parsed, providerMessageId, raw } = input.message;
	const db = getDb(env);
	const messageId = newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = parsed.date ?? new Date();
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
		read: placement.direction === "outbound",
		threadId: await resolveThreadId(db, {
			mailboxId: input.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
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
