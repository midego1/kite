import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentJobs, mailboxAgentSettings, mailboxes, messages } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { aiSummaries } from "@/db/schema/agent-summaries";
import { inJsonArray, queryInChunks } from "@/db/chunk-utils";
import { getDb } from "@/db";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { getMailboxNotificationUserIds, notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import type { MessageFacts } from "../auto-read/facts-types";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import type { MailboxAgentSettingsState } from "../auto-read/settings-types";
import { utcDayStartSeconds } from "../auto-read/spend-utils";
import { agentJobQueueMessage } from "../queue-utils";
import { lineScheduleGate, lineSummaryGate } from "./line-utils";

const logger = createLogger("agent");

type SourceMessage = Pick<
	typeof messages.$inferSelect,
	"id" | "mailboxId" | "threadId" | "status" | "spamVerdict" | "fromAddr"
>;
type Mailbox = typeof mailboxes.$inferSelect;

/** Lines written in the mailbox since 00:00 UTC, by triage or by their own job; unlimited before migration 0072. */
async function linesToday(db: AppDatabase, mailboxId: string, now = new Date()): Promise<number> {
	try {
		const [row] = await db
			.select({ count: sql<number>`count(*)` })
			.from(aiSummaries)
			.where(
				and(
					eq(aiSummaries.mailboxId, mailboxId),
					eq(aiSummaries.kind, "line"),
					gte(aiSummaries.createdAt, new Date(utcDayStartSeconds(now) * 1000)),
				),
			);
		return row?.count ?? 0;
	} catch (error) {
		if (isNoSuchTableError(error)) return Number.POSITIVE_INFINITY;
		throw error;
	}
}

async function phishingOpen(db: AppDatabase, messageId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: agentSuggestions.id })
		.from(agentSuggestions)
		.where(
			and(
				eq(agentSuggestions.messageId, messageId),
				eq(agentSuggestions.kind, "phishing"),
				eq(agentSuggestions.status, "open"),
			),
		)
		.limit(1);
	return !!row;
}

/** Why this message gets no one-line summary now, or null when it qualifies (the full gate, §5.2). */
export async function lineGateFor(
	db: AppDatabase,
	input: { settings: MailboxAgentSettingsState; source: SourceMessage; mailbox: Mailbox; facts: MessageFacts },
): Promise<string | null> {
	const { settings, source, mailbox, facts } = input;
	if (!settings.listSummaries) return "list_summaries_off";
	return lineSummaryGate({
		listSummaries: settings.listSummaries,
		listSummariesBulk: settings.listSummariesBulk,
		status: source.status,
		spamVerdict: source.spamVerdict,
		sender: source.fromAddr,
		ownAddresses: await getMailboxDomainAddresses(db, mailbox),
		facts,
		mutedSenders: settings.capabilities.mutedSenders,
		phishingOpen: await phishingOpen(db, source.id),
		linesToday: await linesToday(db, mailbox.id),
		dailyLimit: settings.listSummaryDailyLimit,
	});
}

/**
 * Saves a message's line, once: the insert is conditional on the message still being in the Inbox or a folder and
 * not judged spam, so mail moved to Spam or Trash meanwhile gets none, and an existing line is kept. Returns whether
 * the message now has a line from this call.
 */
export async function saveLine(
	d1: D1Database,
	input: {
		source: Pick<SourceMessage, "id" | "mailboxId" | "threadId">;
		text: string;
		from: "triage" | "line_job";
		modelId: string | null;
	},
): Promise<boolean> {
	const id = newId("sum");
	const now = Math.floor(Date.now() / 1000);
	await d1
		.prepare(
			`INSERT INTO ai_summaries (id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, covered_count, source, model, language, translation_of, instructions_digest, created_by_user_id, created_at, updated_at)
			SELECT ?, mailbox_id, 'line', coalesce(thread_id, id), id, ?, id, 1, ?, ?, 'und', NULL, '', NULL, ?, ?
			FROM messages WHERE id = ? AND mailbox_id = ? AND status = 'received' AND coalesce(spam_verdict, '') <> 'spam'
			ON CONFLICT DO NOTHING`,
		)
		.bind(id, input.text, input.from, input.modelId, now, now, input.source.id, input.source.mailboxId)
		.run();
	return !!(await d1.prepare("SELECT 1 AS found FROM ai_summaries WHERE id = ?").bind(id).first());
}

/** Tells everyone who can read the mailbox that a row's line arrived; a realtime failure never fails the line. */
export async function notifyLine(env: CloudflareEnv, mailbox: Pick<Mailbox, "id" | "userId">, messageId: string) {
	try {
		const userIds = await getMailboxNotificationUserIds(env, mailbox.id, mailbox.userId);
		await notifyUsersOfNewMessage(env, userIds, { type: "message_summary", mailboxId: mailbox.id, messageId });
	} catch (error) {
		logger.warn("line_summary.notify_failed", { error: error instanceof Error ? error.name : "unknown" });
	}
}

/** Queues the line's own job, at most one per message (the unique index on mailbox, message and kind). */
async function enqueueLineJob(
	env: CloudflareEnv,
	input: { mailboxId: string; sourceMessageId: string; reviewerUserId: string },
) {
	const db = getDb(env);
	const now = new Date();
	const inserted = await db
		.insert(agentJobs)
		.values({
			id: newId("ajob"),
			kind: "line_summary",
			mailboxId: input.mailboxId,
			sourceMessageId: input.sourceMessageId,
			reviewerUserId: input.reviewerUserId,
			status: "pending",
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: agentJobs.id });
	if (inserted[0]) await env.AGENT_QUEUE?.send(agentJobQueueMessage("line_summary", inserted[0].id));
}

export type LineScheduleInput = {
	mailboxId: string;
	sourceMessageId: string;
	ownerUserId: string;
	sender: string;
	status: string;
	spamVerdict?: string | null;
	/** Released by a Screener approval, which counts as new mail. */
	released?: boolean;
};

/**
 * Queues a line job for a delivered (or released) message that no triage job reads: automatic reading is off,
 * or it did not take this message. Only the cheap checks run here; the job checks the rest. Never throws, so
 * delivery is never held up by it.
 */
export async function scheduleLineSummary(env: CloudflareEnv, input: LineScheduleInput): Promise<void> {
	try {
		const db = getDb(env);
		const settings = await readMailboxAgentSettingsRow(db, input.mailboxId);
		if (!settings?.listSummaries) return;
		const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
		const [message] = await db
			.select({ createdAt: messages.createdAt })
			.from(messages)
			.where(eq(messages.id, input.sourceMessageId))
			.limit(1);
		if (!mailbox || !message) return;
		const gate = lineScheduleGate({
			listSummaries: settings.listSummaries,
			status: input.status,
			spamVerdict: input.spamVerdict,
			sender: input.sender,
			ownAddresses: await getMailboxDomainAddresses(db, mailbox),
			createdAt: message.createdAt,
			released: input.released,
		});
		if (gate) return;
		await enqueueLineJob(env, {
			mailboxId: input.mailboxId,
			sourceMessageId: input.sourceMessageId,
			reviewerUserId: settings.reviewerUserId || input.ownerUserId,
		});
	} catch (error) {
		logger.warn("line_summary.schedule_failed", { error: error instanceof Error ? error.name : "unknown" });
	}
}

type ListRow = { id: string; mailboxId: string | null };

/**
 * The `lineSummary` of each list row, in one query per page: a row's own line, or in conversation view the line of
 * the newest message it stands for that has one. Only for mailboxes with one-line summaries on; nothing before
 * migration 0072.
 */
export async function loadRowLines<T extends ListRow>(
	db: AppDatabase,
	rows: readonly T[],
	threadMessageIds: (row: T) => readonly string[],
): Promise<(id: string) => { lineSummary?: string }> {
	const none = () => ({});
	const mailboxIds = [...new Set(rows.map((row) => row.mailboxId).filter((id): id is string => !!id))];
	if (mailboxIds.length === 0) return none;
	try {
		const enabled = await db
			.select({ mailboxId: mailboxAgentSettings.mailboxId })
			.from(mailboxAgentSettings)
			// One JSON parameter: a page can hold rows of more mailboxes than D1 binds parameters.
			.where(
				and(inJsonArray(mailboxAgentSettings.mailboxId, mailboxIds), eq(mailboxAgentSettings.listSummaries, true)),
			);
		const on = new Set(enabled.map((row) => row.mailboxId));
		const members = new Map(
			rows.filter((row) => row.mailboxId && on.has(row.mailboxId)).map((row) => [row.id, threadMessageIds(row)]),
		);
		const ids = [...new Set([...members.values()].flat())];
		if (ids.length === 0) return none;
		const lines = await queryInChunks(ids, (chunk) =>
			db
				.select({ messageId: aiSummaries.messageId, text: aiSummaries.text })
				.from(aiSummaries)
				.innerJoin(messages, eq(messages.id, aiSummaries.messageId))
				.where(and(eq(aiSummaries.kind, "line"), inArray(aiSummaries.messageId, chunk)))
				.orderBy(desc(messages.createdAt)),
		);
		// Newest first: the first line found among a row's messages is the newest one.
		const order = new Map<string, { rank: number; text: string }>();
		for (const line of lines)
			if (line.messageId && !order.has(line.messageId))
				order.set(line.messageId, { rank: order.size, text: line.text });
		return (id) => {
			const found = (members.get(id) ?? [])
				.map((member) => order.get(member))
				.filter((entry) => entry !== undefined)
				.sort((a, b) => a.rank - b.rank)[0];
			return found ? { lineSummary: found.text } : {};
		};
	} catch (error) {
		if (isNoSuchTableError(error) || missingColumnFromError(error)) return none;
		throw error;
	}
}

/**
 * What a triage job does about the line once it has run: nothing when the message does not qualify or the model was
 * refused; the line from its own request when it asked (never a second request, even without a usable line); a
 * line job when it did not ask the model at all. A message the model flagged or that got a phishing warning keeps
 * its plain preview.
 */
export async function settleTriageLine(
	env: CloudflareEnv,
	input: {
		wanted: boolean;
		model: { line?: string; modelId: string; flagged: boolean } | null;
		refused: boolean;
		warned: boolean;
		source: Pick<SourceMessage, "id" | "mailboxId" | "threadId">;
		mailbox: Pick<Mailbox, "id" | "userId">;
		reviewerUserId: string;
	},
): Promise<void> {
	if (!input.wanted || input.refused) return;
	if (input.model) {
		if (!input.model.line || input.model.flagged || input.warned) return;
		const saved = await saveLine(env.DB, {
			source: input.source,
			text: input.model.line,
			from: "triage",
			modelId: input.model.modelId,
		});
		if (saved) await notifyLine(env, input.mailbox, input.source.id);
		return;
	}
	await enqueueLineJob(env, {
		mailboxId: input.mailbox.id,
		sourceMessageId: input.source.id,
		reviewerUserId: input.reviewerUserId,
	});
}
