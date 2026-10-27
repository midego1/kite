import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages, users } from "@/db/schema";
import { composerSends, writingStyleProfiles } from "@/db/schema/agent-writing";
import type { SessionUser } from "@/lib/auth/types";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { readUserAiSettings } from "./user-ai-settings";
import type { StyleMeasurement, WritingStyleProfileState } from "./writing-style-types";
import {
	describeWritingStyle,
	emptyProfile,
	measureMessage,
	ownText,
	updateProfile,
	WRITING_STYLE_METRICS_VERSION,
} from "./writing-style-utils";

const logger = createLogger("agent");
const MAX_ATTEMPTS = 3;
const BACKFILL_MESSAGES = 200;
const BACKFILL_PAGE = 50;
/** A backfill that has not finished in this long is treated as lost, so it can be requested again. */
const BACKFILL_STALE_MS = 60 * 60_000;

export type StyleBackfillMessage = { kind: "agent.style_backfill"; userId: string; mailboxId: string };

type ProfileRow = typeof writingStyleProfiles.$inferSelect;

function parseJson<T>(value: string, fallback: T): T {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
	} catch {
		return fallback;
	}
}

function profileOf(row: ProfileRow | undefined): WritingStyleProfileState {
	if (!row || row.metricsVersion !== WRITING_STYLE_METRICS_VERSION) return emptyProfile();
	return {
		sampleCount: row.sampleCount,
		stats: parseJson(row.stats, {}),
		greetings: parseJson(row.greetings, {}),
		signOffs: parseJson(row.signOffs, {}),
		languages: parseJson(row.languages, {}),
	};
}

const where = (userId: string, mailboxId: string) =>
	and(eq(writingStyleProfiles.userId, userId), eq(writingStyleProfiles.mailboxId, mailboxId));

/** Whether migration 0070's tables exist; before it, the style profile is hidden and nothing is learnt. */
export async function writingStyleAvailable(env: CloudflareEnv): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN ('writing_style_profiles', 'composer_sends')",
	).first<{ present: number }>();
	return Number(row?.present ?? 0) === 2;
}

/**
 * The style description a prompt gets for this user in this mailbox: null while the opt-in is off, before ten
 * samples or before migration 0070. `withoutFormality` is for a request to make text more formal or more casual.
 */
export async function styleDescriptionFor(
	db: AppDatabase,
	userId: string,
	mailboxId: string,
	options: { withoutFormality?: boolean } = {},
): Promise<string | null> {
	if (!(await readUserAiSettings(db, userId)).writingStyleEnabled) return null;
	try {
		const [row] = await db.select().from(writingStyleProfiles).where(where(userId, mailboxId)).limit(1);
		return describeWritingStyle(profileOf(row), options);
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

/**
 * Adds measured messages to the profile with compare-and-set on its version, so two sends at once never lose an
 * update silently: a lost race re-reads and retries up to three times, then the sample is dropped and logged.
 */
export async function updateStyleProfile(
	db: AppDatabase,
	userId: string,
	mailboxId: string,
	measurements: StyleMeasurement[],
): Promise<boolean> {
	if (measurements.length === 0) return true;
	for (let attempt = 0; attempt < MAX_ATTEMPTS + 1; attempt++) {
		const [row] = await db.select().from(writingStyleProfiles).where(where(userId, mailboxId)).limit(1);
		if (!row) {
			await db.insert(writingStyleProfiles).values({ userId, mailboxId }).onConflictDoNothing();
			continue;
		}
		const next = measurements.reduce(updateProfile, profileOf(row));
		const updated = await db
			.update(writingStyleProfiles)
			.set({
				metricsVersion: WRITING_STYLE_METRICS_VERSION,
				sampleCount: next.sampleCount,
				stats: JSON.stringify(next.stats),
				greetings: JSON.stringify(next.greetings),
				signOffs: JSON.stringify(next.signOffs),
				languages: JSON.stringify(next.languages),
				version: row.version + 1,
				updatedAt: new Date(),
			})
			.where(and(where(userId, mailboxId), eq(writingStyleProfiles.version, row.version)))
			.returning({ version: writingStyleProfiles.version });
		if (updated.length > 0) return true;
	}
	logger.warn("writing_style.update_dropped", { samples: measurements.length });
	return false;
}

type ComposerSendInput = {
	messageId: string;
	userId: string;
	mailboxId: string;
	aiAssisted: boolean;
	html: string | null | undefined;
	text: string | null | undefined;
};

/**
 * After a composer send: records it (for a later backfill, whatever the opt-in) and, while the user has opted in and
 * no AI text was inserted, learns from the text they wrote. Never fails the send: errors are logged without content.
 */
export async function learnFromComposerSend(env: CloudflareEnv, input: ComposerSendInput): Promise<void> {
	const db = getDb(env);
	try {
		await db.insert(composerSends).values({
			messageId: input.messageId,
			userId: input.userId,
			mailboxId: input.mailboxId,
			aiAssisted: input.aiAssisted,
		});
	} catch (error) {
		logger.warn("writing_style.send_not_recorded", { pending: isNoSuchTableError(error) });
		return;
	}
	if (input.aiAssisted) return;
	try {
		if (!(await readUserAiSettings(db, input.userId)).writingStyleEnabled) return;
		const measured = measureMessage(ownText(input.html, input.text));
		if (measured) await updateStyleProfile(db, input.userId, input.mailboxId, [measured]);
	} catch {
		logger.warn("writing_style.update_failed", {});
	}
}

/** Deletes one mailbox's profile (Reset). */
export async function resetStyleProfile(db: AppDatabase, userId: string, mailboxId: string): Promise<void> {
	await db.delete(writingStyleProfiles).where(where(userId, mailboxId));
}

/** Deletes every profile of the user, when they turn the opt-in off. */
export async function deleteStyleProfiles(db: AppDatabase, userId: string): Promise<void> {
	try {
		await db.delete(writingStyleProfiles).where(eq(writingStyleProfiles.userId, userId));
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
	}
}

export type StyleProfileSummary = {
	mailboxId: string;
	address: string;
	sampleCount: number;
	description: string | null;
	backfillPending: boolean;
};

/** One entry per mailbox the user can send from: the sample count and exactly what Kite tells the AI. */
export async function listStyleProfiles(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "email" | "role">,
): Promise<StyleProfileSummary[]> {
	const sendable = (await listAccessibleMailboxes(db, user)).filter((mailbox) => mailbox.permission !== "read_only");
	if (sendable.length === 0) return [];
	const rows = await db
		.select()
		.from(writingStyleProfiles)
		.where(
			and(
				eq(writingStyleProfiles.userId, user.id),
				inArray(
					writingStyleProfiles.mailboxId,
					sendable.map((mailbox) => mailbox.id),
				),
			),
		);
	const byMailbox = new Map(rows.map((row) => [row.mailboxId, row]));
	return sendable.map((mailbox) => {
		const row = byMailbox.get(mailbox.id);
		const profile = profileOf(row);
		return {
			mailboxId: mailbox.id,
			address: `${mailbox.localPart}@${mailbox.hostname}`,
			sampleCount: profile.sampleCount,
			description: describeWritingStyle(profile),
			backfillPending: !!row?.backfillRequestedAt && Date.now() - row.backfillRequestedAt.getTime() < BACKFILL_STALE_MS,
		};
	});
}

/**
 * Queues a backfill from the user's last 200 composer sends in this mailbox. At most one per user and mailbox at a
 * time: `pending` when one is already queued or running.
 */
export async function requestStyleBackfill(
	env: CloudflareEnv,
	user: SessionUser,
	mailboxId: string,
): Promise<"queued" | "pending" | "not_found"> {
	const db = getDb(env);
	if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canSendOnBehalf) return "not_found";
	await db.insert(writingStyleProfiles).values({ userId: user.id, mailboxId }).onConflictDoNothing();
	const claimed = await db
		.update(writingStyleProfiles)
		.set({ backfillRequestedAt: new Date() })
		.where(
			and(
				where(user.id, mailboxId),
				or(
					isNull(writingStyleProfiles.backfillRequestedAt),
					lt(writingStyleProfiles.backfillRequestedAt, new Date(Date.now() - BACKFILL_STALE_MS)),
				),
			),
		)
		.returning({ mailboxId: writingStyleProfiles.mailboxId });
	if (claimed.length === 0) return "pending";
	const message: StyleBackfillMessage = { kind: "agent.style_backfill", userId: user.id, mailboxId };
	if (env.AGENT_QUEUE) await env.AGENT_QUEUE.send(message);
	else await processStyleBackfill(env, message);
	return "queued";
}

export function isStyleBackfillMessage(body: unknown): body is StyleBackfillMessage {
	if (typeof body !== "object" || body === null) return false;
	const { kind, userId, mailboxId } = body as Record<string, unknown>;
	return kind === "agent.style_backfill" && typeof userId === "string" && typeof mailboxId === "string";
}

/**
 * Rebuilds the profile from the user's last 200 composer sends in the mailbox, oldest first, in pages of 50. Only
 * sends with a `composer_sends` row count, and none that AI text was inserted into, so mail sent before migration
 * 0070, through the API, MCP, JMAP or by the assistant is never learnt from. No model and no spend.
 */
export async function processStyleBackfill(env: CloudflareEnv, message: StyleBackfillMessage): Promise<void> {
	const db = getDb(env);
	const { userId, mailboxId } = message;
	try {
		const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
		const access = user && !user.disabled ? await getMailboxAccessLevel(db, user, mailboxId) : null;
		if (!access?.canSendOnBehalf || !(await readUserAiSettings(db, userId)).writingStyleEnabled) return;
		const sent = await db
			.select({ html: messages.htmlBody, text: messages.textBody })
			.from(composerSends)
			.innerJoin(messages, eq(messages.id, composerSends.messageId))
			.where(
				and(
					eq(composerSends.userId, userId),
					eq(composerSends.mailboxId, mailboxId),
					eq(composerSends.aiAssisted, false),
					eq(messages.status, "sent"),
				),
			)
			.orderBy(desc(composerSends.createdAt))
			.limit(BACKFILL_MESSAGES);
		// The backfill starts over, so a send learnt live before it is not counted twice.
		await db
			.update(writingStyleProfiles)
			.set({
				sampleCount: 0,
				stats: "{}",
				greetings: "{}",
				signOffs: "{}",
				languages: "{}",
				version: sql`${writingStyleProfiles.version} + 1`,
				updatedAt: new Date(),
			})
			.where(where(userId, mailboxId));
		const oldestFirst = sent.reverse();
		for (let start = 0; start < oldestFirst.length; start += BACKFILL_PAGE) {
			const page = oldestFirst
				.slice(start, start + BACKFILL_PAGE)
				.map((row) => measureMessage(ownText(row.html, row.text)))
				.filter((measured): measured is StyleMeasurement => measured !== null);
			await updateStyleProfile(db, userId, mailboxId, page);
		}
	} finally {
		await db
			.update(writingStyleProfiles)
			.set({ backfillRequestedAt: null })
			.where(where(userId, mailboxId))
			.catch(() => undefined);
	}
}
