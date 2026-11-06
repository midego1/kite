import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { aiSummaries } from "@/db/schema/agent-summaries";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { StoredTranslation } from "./translation-types";

const KIND = "message_translation";

/** What a row says: the translation, the digest of the pieces it lines up with, and who wrote it. */
export type StoredTranslationRow = { content: StoredTranslation; digest: string; model: string | null };

function readContent(text: string): StoredTranslation | null {
	try {
		const value = JSON.parse(text) as Partial<StoredTranslation>;
		if (!Array.isArray(value.segments)) return null;
		return { from: String(value.from ?? "und"), subject: value.subject ?? null, segments: value.segments };
	} catch {
		return null;
	}
}

/** The stored translation of a message into `language`; `pending` before migration 0072. */
export async function readMessageTranslation(
	db: AppDatabase,
	messageId: string,
	language: string,
): Promise<{ pending: boolean; row: StoredTranslationRow | null }> {
	try {
		const [row] = await db
			.select({ text: aiSummaries.text, digest: aiSummaries.coverageDigest, model: aiSummaries.model })
			.from(aiSummaries)
			.where(and(eq(aiSummaries.messageId, messageId), eq(aiSummaries.kind, KIND), eq(aiSummaries.language, language)))
			.limit(1);
		const content = row ? readContent(row.text) : null;
		return { pending: false, row: row && content ? { content, digest: row.digest, model: row.model } : null };
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { pending: true, row: null };
	}
}

export type SaveTranslationInput = {
	mailboxId: string;
	threadKey: string;
	messageId: string;
	language: string;
	content: StoredTranslation;
	digest: string;
	modelId: string | null;
	userId: string | null;
	now?: Date;
};

/**
 * Saves a translation in place of the one before it. The insert is conditional, as a summary's: a message deleted
 * or moved to Spam or Trash while the model was writing does not come back through the answer, and the triggers of
 * migration 0072 delete the row with its message afterwards. Returns whether it was saved.
 */
export async function saveMessageTranslation(d1: D1Database, input: SaveTranslationInput): Promise<boolean> {
	const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const match = "message_id = ? AND kind = ? AND language = ?";
	const matchValues = [input.messageId, KIND, input.language];
	const covered = input.content.segments.filter((segment) => segment !== null).length;
	await d1.batch([
		d1.prepare(`DELETE FROM ai_summaries WHERE ${match}`).bind(...matchValues),
		d1
			.prepare(
				`INSERT INTO ai_summaries (id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, covered_count, source, model, language, translation_of, instructions_digest, created_by_user_id, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'button', ?, ?, NULL, '', ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND mailbox_id = ? AND status IN ('received', 'sent', 'archived') AND coalesce(spam_verdict, '') <> 'spam')`,
			)
			.bind(
				newId("sum"),
				input.mailboxId,
				KIND,
				input.threadKey,
				input.messageId,
				JSON.stringify(input.content),
				input.digest,
				covered,
				input.modelId,
				input.language,
				input.userId,
				now,
				now,
				input.messageId,
				input.mailboxId,
			),
	]);
	return !!(await d1
		.prepare(`SELECT 1 AS found FROM ai_summaries WHERE ${match} LIMIT 1`)
		.bind(...matchValues)
		.first());
}
