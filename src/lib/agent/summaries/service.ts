import { bodyBytesColumn, withStoredBodies } from "@/lib/messages/body-batches";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { loadMessageBodies } from "@/lib/email/bodies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import { aiErrorMessage } from "../ai-error-utils";
import { mailboxAiOff } from "../mailbox-ai";
import type { AutoSpendSource } from "../auto-read/spend-types";
import { interactiveRefusal } from "../interactive-model";
import { getAgentProviderPublicConfig } from "../provider";
import { personalInstructionsFor } from "../user-ai-settings";
import { agentThreadCondition } from "../thread-context";
import {
	buildSummaryPrompt,
	buildTranslationPrompt,
	isSummaryEligible,
	SUMMARY_FULL_MESSAGES,
	SUMMARY_MAX_OUTPUT_TOKENS,
	SUMMARY_STATUSES,
	summaryReferences,
	summaryText,
} from "./summary-prompt-utils";
import { checkedModelAnswer, SummaryRefusal } from "./model-answer";
import { readCachedSummary, saveSummary, saveTranslation, storedContent, type SummaryKey } from "./store";
import type { SummaryContent, SummaryMessage, SummaryPrompt, SummaryScope, SummaryState } from "./summary-types";
import {
	canTranslate,
	checkSummaryOutput,
	coverageDigest,
	instructionsDigest,
	languageCode,
	summaryProblemText,
} from "./summary-utils";

// Conversations longer than this are summarised from their newest messages; the rest are left out.
const MAX_COVERED_MESSAGES = 200;
const SUMMARY_CALL_TIMEOUT_MS = 60_000;
const ELIGIBLE = [...SUMMARY_STATUSES];

export { SummaryRefusal };

export type Anchor = {
	id: string;
	mailboxId: string;
	threadKey: string;
	status: string;
	spamVerdict: string | null;
};

/**
 * The opened message, when the user can read its mailbox; another user's draft and mail of a mailbox they cannot
 * read are not found, so ids do not leak.
 */
export async function loadAnchor(db: AppDatabase, user: SessionUser, messageId: string): Promise<Anchor> {
	const [row] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			userId: messages.userId,
			threadId: messages.threadId,
			status: messages.status,
			spamVerdict: messages.spamVerdict,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	const access = row?.mailboxId ? await getMailboxAccessLevel(db, user, row.mailboxId) : null;
	if (!row?.mailboxId || !access?.canRead || (row.status === "draft" && row.userId !== user.id))
		throw new SummaryRefusal(404, "Message not found", "not_found");
	return {
		id: row.id,
		mailboxId: row.mailboxId,
		threadKey: row.threadId ?? row.id,
		status: row.status,
		spamVerdict: row.spamVerdict,
	};
}

function coveredCondition(anchor: Anchor, scope: SummaryScope) {
	return and(
		eq(messages.mailboxId, anchor.mailboxId),
		scope === "message"
			? eq(messages.id, anchor.id)
			: sql`coalesce(${messages.threadId}, ${messages.id}) = ${anchor.threadKey}`,
		inArray(messages.status, ELIGIBLE),
		sql`coalesce(${messages.spamVerdict}, '') <> 'spam'`,
		// The same rows the assistant's other thread readers see; ELIGIBLE already leaves out drafts.
		agentThreadCondition(anchor.id, null),
	);
}

/**
 * The ids of the eligible messages a summary of this scope covers: the newest 200 of the conversation, or the one
 * message. Reading a summary needs only these, for the coverage digest; no body is loaded.
 */
async function loadCoveredIds(db: AppDatabase, anchor: Anchor, scope: SummaryScope): Promise<string[]> {
	if (!isSummaryEligible(anchor)) return [];
	const rows = await db
		.select({ id: messages.id })
		.from(messages)
		.where(coveredCondition(anchor, scope))
		.orderBy(desc(messages.createdAt))
		.limit(MAX_COVERED_MESSAGES);
	return rows.map((row) => row.id);
}

/**
 * The covered messages as the prompt reads them, oldest first: headers for all of them, bodies only for the newest
 * `SUMMARY_FULL_MESSAGES` (the earlier ones appear as one line each).
 */
async function loadCoveredMessages(env: CloudflareEnv, anchor: Anchor, scope: SummaryScope): Promise<SummaryMessage[]> {
	if (!isSummaryEligible(anchor)) return [];
	const db = getDb(env);
	const rows = await db
		.select({
			id: messages.id,
			from: messages.fromAddr,
			subject: messages.subject,
			createdAt: messages.createdAt,
			direction: messages.direction,
		})
		.from(messages)
		.where(coveredCondition(anchor, scope))
		.orderBy(desc(messages.createdAt))
		.limit(MAX_COVERED_MESSAGES);
	const newest = rows.slice(0, SUMMARY_FULL_MESSAGES).map((row) => row.id);
	const bodies = newest.length
		? await loadMessageBodies(
				env,
				await withStoredBodies(
					db,
					await db
						.select({ id: messages.id, bodyBytes: bodyBytesColumn })
						.from(messages)
						.where(inArray(messages.id, newest)),
				),
			)
		: [];
	const text = new Map(bodies.map((row) => [row.id, summaryText(row)]));
	return rows.reverse().map((row) => ({
		id: row.id,
		from: row.from,
		subject: row.subject ?? "",
		date: row.createdAt,
		direction: row.direction === "outbound" ? "outbound" : "inbound",
		text: text.get(row.id) ?? "",
	}));
}

function keyOf(anchor: Anchor, scope: SummaryScope, digest: string): SummaryKey {
	return {
		mailboxId: anchor.mailboxId,
		kind: scope,
		threadKey: anchor.threadKey,
		messageId: scope === "message" ? anchor.id : null,
		digest,
	};
}

type SummaryRequest = { scope: SummaryScope; language: string | null };

/**
 * Why the button cannot run here, if it cannot: the message is excluded, the assistant is off or unconfigured, or AI
 * is off for the mailbox.
 */
export async function unavailableReason(
	env: CloudflareEnv,
	eligible: boolean,
	mailboxId: string,
): Promise<SummaryState["reason"]> {
	const refusal = await interactiveRefusal(env, mailboxId);
	if (refusal === "assistant_disabled") return "assistant_off";
	if (refusal === "mailbox_ai_off") return refusal;
	if (refusal === "external_provider_not_allowed" || refusal === "provider_key_unreadable") return refusal;
	if (refusal === "not_configured" || !(await getAgentProviderPublicConfig(env)).configured) return "no_provider";
	return eligible ? undefined : "not_eligible";
}

type Loaded = { anchor: Anchor; coveredIds: string[]; key: SummaryKey; current: string };

async function load(env: CloudflareEnv, user: SessionUser, messageId: string, scope: SummaryScope): Promise<Loaded> {
	const db = getDb(env);
	const anchor = await loadAnchor(db, user, messageId);
	const coveredIds = await loadCoveredIds(db, anchor, scope);
	const personal = await personalInstructionsFor(db, user);
	const key = keyOf(anchor, scope, await instructionsDigest(personal));
	return { anchor, coveredIds, key, current: await coverageDigest(coveredIds) };
}

/**
 * The reader's summary for one message and scope: the cached summary for this user's instructions (shared by
 * everyone without personal summary instructions), whether it is out of date, its translation into the user's
 * language and whether one can be made, and whether the button can run.
 */
export async function getSummaryState(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	request: SummaryRequest,
): Promise<SummaryState> {
	const loaded = await load(env, user, messageId, request.scope);
	return stateOf(env, loaded, request);
}

async function stateOf(env: CloudflareEnv, loaded: Loaded, request: SummaryRequest): Promise<SummaryState> {
	const eligible = loaded.coveredIds.length > 0;
	const reason = await unavailableReason(env, eligible, loaded.anchor.mailboxId);
	const empty = { summary: null, translation: null, translatable: false };
	// With AI off for the mailbox nothing stored is shown either; turning it off deleted the summaries.
	if (reason === "assistant_off" || reason === "mailbox_ai_off") return { ...empty, eligible: false, reason };
	const cached = await readCachedSummary(getDb(env), loaded.key, request.language);
	if (cached.pending) return { ...empty, eligible: false, migrationPending: true };
	const base = { eligible: !reason, ...(reason ? { reason } : {}) };
	if (!cached.source) return { ...empty, ...base };
	const stale = !eligible || cached.source.coverageDigest !== loaded.current;
	return {
		summary: {
			scope: request.scope,
			language: cached.source.language,
			...storedContent(cached.source),
			stale,
			createdAt: cached.source.updatedAt.toISOString(),
			model: cached.source.model,
		},
		translation: cached.translation
			? { language: cached.translation.language, ...storedContent(cached.translation) }
			: null,
		translatable: canTranslate(cached.source.language, request.language),
		...base,
	};
}

/**
 * One summary or translation, checked by code: an unusable answer gets one repair turn, a second one is an error
 * that says what was wrong.
 */
async function generate(input: {
	env: CloudflareEnv;
	userId: string;
	mailboxId: string;
	source: Extract<AutoSpendSource, "summary" | "summary_translation">;
	prompt: SummaryPrompt;
	references: string[];
	language?: string;
}): Promise<{ summary: SummaryContent; modelId: string }> {
	const { references, language, ...request } = input;
	const { value, modelId } = await checkedModelAnswer<SummaryContent>({
		...request,
		answerTokens: SUMMARY_MAX_OUTPUT_TOKENS,
		timeoutMs: SUMMARY_CALL_TIMEOUT_MS,
		check: (text) => {
			const parsed = checkSummaryOutput(text, { references, ...(language ? { language } : {}) });
			return parsed.ok ? { ok: true, value: parsed.summary } : parsed;
		},
		problemText: summaryProblemText,
	});
	return { summary: value, modelId };
}

const changed = () => new SummaryRefusal(409, "The conversation changed; summarize again.", "conversation_changed");

/**
 * Makes the summary for one message and scope, or its translation into `translateTo`. A current summary (or an
 * existing translation) is returned without a model call. Read-only users of a shared mailbox may do this too: it
 * shows nothing they cannot read and is charged to the mailbox.
 */
export async function createSummary(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	request: SummaryRequest & { translateTo?: string | null },
): Promise<SummaryState> {
	const loaded = await load(env, user, messageId, request.scope);
	if (await mailboxAiOff(env, loaded.anchor.mailboxId))
		throw new SummaryRefusal(403, aiErrorMessage("mailbox_ai_off"), "mailbox_ai_off");
	if (!loaded.coveredIds.length) throw new SummaryRefusal(409, "This message cannot be summarized.", "not_eligible");
	const cached = await readCachedSummary(getDb(env), loaded.key, request.translateTo ?? null);
	if (cached.pending) throw new SummaryRefusal(409, "Apply the pending database update first", "MIGRATION_PENDING");
	const current = cached.source && cached.source.coverageDigest === loaded.current ? cached.source : null;
	if (request.translateTo) {
		const target = languageCode(request.translateTo);
		if (!current) throw changed();
		if (!cached.translation && canTranslate(current.language, target)) {
			const content = storedContent(current);
			const { summary, modelId } = await generate({
				env,
				userId: user.id,
				mailboxId: loaded.anchor.mailboxId,
				source: "summary_translation",
				prompt: buildTranslationPrompt({ summary: content, target }),
				references: [content.overview, ...content.points.map((point) => point.text)],
				language: target,
			});
			if (!(await saveTranslation(env.DB, { sourceId: current.id, translation: summary, modelId, userId: user.id })))
				throw changed();
		}
		return stateOf(env, loaded, { scope: request.scope, language: target });
	}
	if (!current) {
		const db = getDb(env);
		const settings = await readMailboxAgentSettingsRow(db, loaded.anchor.mailboxId);
		// Bodies are read only here; the saved coverage is exactly what the model read.
		const covered = await loadCoveredMessages(env, loaded.anchor, request.scope);
		if (!covered.length) throw changed();
		const coveredIds = covered.map((message) => message.id);
		const { summary, modelId } = await generate({
			env,
			userId: user.id,
			mailboxId: loaded.anchor.mailboxId,
			source: "summary",
			prompt: buildSummaryPrompt({
				messages: covered,
				instructions: { general: settings?.instructions ?? "", summary: settings?.summaryInstructions ?? "" },
				personal: await personalInstructionsFor(db, user),
			}),
			references: summaryReferences(covered),
		});
		const coverage = await coverageDigest(coveredIds);
		const saved = await saveSummary(env.DB, {
			key: loaded.key,
			coveredIds,
			coverageDigest: coverage,
			summary,
			modelId,
			userId: user.id,
		});
		if (!saved) throw changed();
		return stateOf(env, { ...loaded, coveredIds, current: coverage }, request);
	}
	return stateOf(env, loaded, request);
}

/**
 * The cached conversation summary of a message for the assistant chat, when one is current for everyone without
 * personal summary instructions; null otherwise (and before migration 0072).
 */
export async function currentThreadSummary(env: CloudflareEnv, user: SessionUser, messageId: string) {
	try {
		const db = getDb(env);
		const anchor = await loadAnchor(db, user, messageId);
		if (await mailboxAiOff(env, anchor.mailboxId)) return null;
		const coveredIds = await loadCoveredIds(db, anchor, "thread");
		if (!coveredIds.length) return null;
		const cached = await readCachedSummary(db, keyOf(anchor, "thread", ""), null);
		const current = await coverageDigest(coveredIds);
		if (!cached.source || cached.source.coverageDigest !== current) return null;
		return { language: cached.source.language, ...storedContent(cached.source) };
	} catch (error) {
		if (error instanceof SummaryRefusal) return null;
		throw error;
	}
}
