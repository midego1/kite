import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { aiSummaries } from "@/db/schema/agent-summaries";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { SummaryContent, SummaryScope } from "./summary-types";

/** What identifies a cached summary: mailbox, scope, conversation, message (for a message summary) and instructions. */
export type SummaryKey = {
	mailboxId: string;
	kind: SummaryScope;
	threadKey: string;
	messageId: string | null;
	digest: string;
};

function keyCondition(key: SummaryKey) {
	return and(
		eq(aiSummaries.mailboxId, key.mailboxId),
		eq(aiSummaries.kind, key.kind),
		eq(aiSummaries.threadKey, key.threadKey),
		key.messageId ? eq(aiSummaries.messageId, key.messageId) : isNull(aiSummaries.messageId),
		eq(aiSummaries.instructionsDigest, key.digest),
	);
}

export type SummaryRow = typeof aiSummaries.$inferSelect;

/** The cached summary of this key and its translation into `language`; null before migration 0072. */
export async function readCachedSummary(db: AppDatabase, key: SummaryKey, language: string | null) {
	try {
		const [source] = await db
			.select()
			.from(aiSummaries)
			.where(and(keyCondition(key), isNull(aiSummaries.translationOf)))
			.orderBy(desc(aiSummaries.updatedAt))
			.limit(1);
		const [translation] =
			source && language
				? await db
						.select()
						.from(aiSummaries)
						.where(and(eq(aiSummaries.translationOf, source.id), eq(aiSummaries.language, language)))
						.limit(1)
				: [];
		return { pending: false, source: source ?? null, translation: translation ?? null };
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { pending: true, source: null, translation: null };
	}
}

export function storedContent(row: SummaryRow): Pick<SummaryContent, "overview" | "points"> {
	try {
		const value = JSON.parse(row.text) as Partial<SummaryContent>;
		return { overview: String(value.overview ?? ""), points: Array.isArray(value.points) ? value.points : [] };
	} catch {
		return { overview: "", points: [] };
	}
}

export type SaveSummaryInput = {
	key: SummaryKey;
	/** The ids of the messages the summary covers; every one must still be eligible for the row to be written. */
	coveredIds: readonly string[];
	coverageDigest: string;
	summary: SummaryContent;
	modelId: string | null;
	userId: string | null;
	now?: Date;
};

const INSERT_COLUMNS =
	"id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, covered_count, source, model, language, translation_of, instructions_digest, created_by_user_id, created_at, updated_at";

const storedText = (summary: SummaryContent) => JSON.stringify({ overview: summary.overview, points: summary.points });

const seconds = (now: Date | undefined) => Math.floor((now ?? new Date()).getTime() / 1000);

async function exists(d1: D1Database, query: string, values: unknown[]): Promise<boolean> {
	// A batch reports `meta.changes` differently on D1 and locally, so the rows themselves say what was written.
	return !!(await d1
		.prepare(`SELECT 1 AS found FROM ai_summaries WHERE ${query} LIMIT 1`)
		.bind(...values)
		.first());
}

/**
 * Saves a summary in place of the key's earlier one (and that one's translations), in one batch whose insert is
 * conditional: it writes only while every covered message still exists and is eligible, so a message deleted or
 * moved to Spam or Trash while the model was writing cannot come back through the answer. A summary of the same
 * coverage that someone else saved meanwhile is kept (with its translations) and counts as success. Returns whether
 * a current summary for the key and coverage now exists.
 */
export async function saveSummary(d1: D1Database, input: SaveSummaryInput): Promise<boolean> {
	const { key } = input;
	const now = seconds(input.now);
	const match =
		"mailbox_id = ? AND kind = ? AND thread_key = ? AND coalesce(message_id, '') = ? AND instructions_digest = ? AND translation_of IS NULL";
	const matchValues = [key.mailboxId, key.kind, key.threadKey, key.messageId ?? "", key.digest];
	const older = `${match} AND coverage_digest <> ?`;
	const same = `${match} AND coverage_digest = ?`;
	const olderValues = [...matchValues, input.coverageDigest];
	await d1.batch([
		d1
			.prepare(`DELETE FROM ai_summaries WHERE translation_of IN (SELECT id FROM ai_summaries WHERE ${older})`)
			.bind(...olderValues),
		d1.prepare(`DELETE FROM ai_summaries WHERE ${older}`).bind(...olderValues),
		d1
			.prepare(
				`INSERT INTO ai_summaries (${INSERT_COLUMNS})
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'button', ?, ?, NULL, ?, ?, ?, ?
				WHERE (SELECT count(*) FROM messages, json_each(?) WHERE messages.id = json_each.value AND messages.mailbox_id = ? AND messages.status IN ('received', 'sent', 'archived') AND coalesce(messages.spam_verdict, '') <> 'spam') = ?
				AND NOT EXISTS (SELECT 1 FROM ai_summaries WHERE ${same})`,
			)
			.bind(
				newId("sum"),
				key.mailboxId,
				key.kind,
				key.threadKey,
				key.messageId,
				storedText(input.summary),
				input.coverageDigest,
				input.coveredIds.length,
				input.modelId,
				input.summary.language,
				key.digest,
				input.userId,
				now,
				now,
				JSON.stringify(input.coveredIds),
				key.mailboxId,
				input.coveredIds.length,
				...olderValues,
			),
	]);
	return exists(d1, same, olderValues);
}

/**
 * Saves a translation next to its source row, only while that source still exists. A translation into the same
 * language that someone else saved meanwhile is kept and counts as success.
 */
export async function saveTranslation(
	d1: D1Database,
	input: { sourceId: string; translation: SummaryContent; modelId: string | null; userId: string | null; now?: Date },
): Promise<boolean> {
	const now = seconds(input.now);
	const same = "translation_of = ? AND language = ?";
	const sameValues = [input.sourceId, input.translation.language];
	await d1
		.prepare(
			`INSERT INTO ai_summaries (${INSERT_COLUMNS})
			SELECT ?, mailbox_id, kind, thread_key, message_id, ?, coverage_digest, covered_count, 'button', ?, ?, id, instructions_digest, ?, ?, ?
			FROM ai_summaries WHERE id = ? AND translation_of IS NULL AND NOT EXISTS (SELECT 1 FROM ai_summaries WHERE ${same})`,
		)
		.bind(
			newId("sum"),
			storedText(input.translation),
			input.modelId,
			input.translation.language,
			input.userId,
			now,
			now,
			input.sourceId,
			...sameValues,
		)
		.run();
	return exists(d1, same, sameValues);
}
