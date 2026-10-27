import { generateText, type LanguageModelUsage } from "ai";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createLogger } from "@/lib/logger.mjs";
import type { SessionUser } from "@/lib/auth/types";
import { getAutoReadInstallSettings } from "../auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import { buildModelCallOptions, callWithFallback, completedText } from "../auto-read/model-call-utils";
import { refusedSpendCap, withReservedSpend } from "../auto-read/spend";
import type { AutoSpendSource, ReserveAiSpendInput } from "../auto-read/spend-types";
import { spendCapMessage } from "../chat-spend-utils";
import { InteractiveModelRefusedError, interactiveRefusal, selectInteractiveModel } from "../interactive-model";
import { getAgentProviderPublicConfig } from "../provider";
import { personalInstructionsFor } from "../user-ai-settings";
import {
	buildSummaryPrompt,
	buildSummaryRepairPrompt,
	buildTranslationPrompt,
	isSummaryEligible,
	SUMMARY_MAX_OUTPUT_TOKENS,
	SUMMARY_STATUSES,
	summaryReferences,
	summaryText,
} from "./summary-prompt-utils";
import { readCachedSummary, saveSummary, saveTranslation, storedContent, type SummaryKey } from "./store";
import type { SummaryContent, SummaryMessage, SummaryPrompt, SummaryScope, SummaryState } from "./summary-types";
import { canTranslate, checkSummaryOutput, coverageDigest, instructionsDigest, languageCode } from "./summary-utils";

const logger = createLogger("agent");
// Conversations longer than this are summarised from their newest messages; the rest are left out.
const MAX_COVERED_MESSAGES = 200;
const SUMMARY_CALL_TIMEOUT_MS = 60_000;
const ELIGIBLE = [...SUMMARY_STATUSES];

/** A request answered with its status and a code before or instead of a saved summary. */
export class SummaryRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "SummaryRefusal";
	}
}

type Anchor = {
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
async function loadAnchor(db: AppDatabase, user: SessionUser, messageId: string): Promise<Anchor> {
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

/** The eligible messages a summary of this scope covers, oldest first: the newest 200 of the conversation, or one. */
async function loadCovered(db: AppDatabase, anchor: Anchor, scope: SummaryScope): Promise<SummaryMessage[]> {
	if (!isSummaryEligible(anchor)) return [];
	const rows = await db
		.select({
			id: messages.id,
			from: messages.fromAddr,
			subject: messages.subject,
			createdAt: messages.createdAt,
			direction: messages.direction,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
		})
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, anchor.mailboxId),
				scope === "message"
					? eq(messages.id, anchor.id)
					: sql`coalesce(${messages.threadId}, ${messages.id}) = ${anchor.threadKey}`,
				inArray(messages.status, ELIGIBLE),
				sql`coalesce(${messages.spamVerdict}, '') <> 'spam'`,
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(MAX_COVERED_MESSAGES);
	return rows.reverse().map((row) => ({
		id: row.id,
		from: row.from,
		subject: row.subject ?? "",
		date: row.createdAt,
		direction: row.direction === "outbound" ? "outbound" : "inbound",
		text: summaryText(row),
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

/** Why the button cannot run here, if it cannot: the message is excluded, the assistant is off or unconfigured. */
async function unavailableReason(env: CloudflareEnv, eligible: boolean): Promise<SummaryState["reason"]> {
	const refusal = await interactiveRefusal(env);
	if (refusal === "assistant_disabled") return "assistant_off";
	if (refusal === "external_provider_not_allowed") return refusal;
	if (refusal === "not_configured" || !(await getAgentProviderPublicConfig(env)).configured) return "no_provider";
	return eligible ? undefined : "not_eligible";
}

type Loaded = { anchor: Anchor; covered: SummaryMessage[]; key: SummaryKey; current: string };

async function load(env: CloudflareEnv, user: SessionUser, messageId: string, scope: SummaryScope): Promise<Loaded> {
	const db = getDb(env);
	const anchor = await loadAnchor(db, user, messageId);
	const covered = await loadCovered(db, anchor, scope);
	const personal = await personalInstructionsFor(db, user);
	const key = keyOf(anchor, scope, await instructionsDigest(personal));
	return { anchor, covered, key, current: await coverageDigest(covered.map((message) => message.id)) };
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
	const eligible = loaded.covered.length > 0;
	const reason = await unavailableReason(env, eligible);
	const empty = { summary: null, translation: null, translatable: false };
	if (reason === "assistant_off") return { ...empty, eligible: false, reason };
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

type ModelSelection = Awaited<ReturnType<typeof selectInteractiveModel>>;

type GenerateInput = {
	env: CloudflareEnv;
	mailboxId: string;
	source: AutoSpendSource;
	prompt: SummaryPrompt;
	references: string[];
	language?: string;
};

/** Reserves the spend of one request, or refuses with the message that names the cap. */
async function reserved<T extends { usage: LanguageModelUsage | undefined }>(
	reserve: ReserveAiSpendInput,
	call: () => Promise<T>,
) {
	const result = await withReservedSpend(reserve, call);
	if (result) return result;
	const cap = await refusedSpendCap(reserve);
	throw new SummaryRefusal(429, spendCapMessage(cap, reserve), "spend_cap");
}

/**
 * One summary or translation: the model chosen and the opt-in checked again for every request (the repair turn
 * too), each request's estimate reserved against the mailbox and install caps and settled with its usage, the
 * answer checked by code. An unusable answer gets one repair turn; a second one is an error.
 */
async function generate(input: GenerateInput): Promise<{ summary: SummaryContent; modelId: string }> {
	const db = getDb(input.env);
	const settings = await readMailboxAgentSettingsRow(db, input.mailboxId);
	const install = await getAutoReadInstallSettings(input.env);
	const call = async (prompt: SummaryPrompt) => {
		const selection: ModelSelection = await selectInteractiveModel(input.env, settings?.modelId);
		const options = buildModelCallOptions({
			provider: selection.providerKind,
			preset: selection.preset,
			kind: "draft",
			reasoningEffort: selection.reasoningEffort,
		});
		// The options' budget includes a reasoning model's headroom; keep it on top of this request's own.
		const base = {
			...options,
			maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS + Math.max(0, options.maxOutputTokens - 900),
		};
		const text = await callWithFallback(base, (current) =>
			reserved(
				{
					env: input.env,
					details: selection,
					source: input.source,
					mailboxId: input.mailboxId,
					jobId: null,
					promptChars: prompt.system.length + prompt.messages.reduce((sum, message) => sum + message.content.length, 0),
					maxOutputTokens: current.maxOutputTokens,
					installCapMicros: install.dailySpendCapMicros,
					mailboxCapMicros: settings?.dailySpendCapMicros ?? null,
					tokenCap: install.chatTokenCap,
				},
				() =>
					generateText({
						model: selection.model,
						system: prompt.system,
						messages: prompt.messages,
						maxOutputTokens: current.maxOutputTokens,
						providerOptions: current.providerOptions,
						maxRetries: 0,
						abortSignal: AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS),
					}),
			),
		).then(completedText);
		return { text, modelId: selection.modelId };
	};
	const check = (text: string) =>
		checkSummaryOutput(text, { references: input.references, ...(input.language ? { language: input.language } : {}) });
	try {
		const first = await call(input.prompt);
		const parsed = check(first.text);
		if (parsed.ok) return { summary: parsed.summary, modelId: first.modelId };
		const second = await call(buildSummaryRepairPrompt(input.prompt, first.text, parsed.error));
		const repaired = check(second.text);
		if (repaired.ok) return { summary: repaired.summary, modelId: second.modelId };
		logger.warn("summary.unusable_answer", { source: input.source });
		throw new SummaryRefusal(502, "Kite could not write a usable summary. Try again.", "unusable_answer");
	} catch (error) {
		if (error instanceof SummaryRefusal) throw error;
		// The provider's own text may echo content; only a code is logged and a fixed message returned.
		if (error instanceof InteractiveModelRefusedError) throw error;
		const status = (error as { statusCode?: unknown } | null)?.statusCode;
		logger.warn("summary.failed", { code: typeof status === "number" ? `provider_${status}` : "provider_error" });
		throw new SummaryRefusal(502, "The AI provider could not finish this. Try again.", "provider_error");
	}
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
	if (!loaded.covered.length) throw new SummaryRefusal(409, "This message cannot be summarized.", "not_eligible");
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
		const { summary, modelId } = await generate({
			env,
			mailboxId: loaded.anchor.mailboxId,
			source: "summary",
			prompt: buildSummaryPrompt({
				messages: loaded.covered,
				instructions: { general: settings?.instructions ?? "", summary: settings?.summaryInstructions ?? "" },
				personal: await personalInstructionsFor(db, user),
			}),
			references: summaryReferences(loaded.covered),
		});
		const saved = await saveSummary(env.DB, {
			key: loaded.key,
			coveredIds: loaded.covered.map((message) => message.id),
			coverageDigest: loaded.current,
			summary,
			modelId,
			userId: user.id,
		});
		if (!saved) throw changed();
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
		const covered = await loadCovered(db, anchor, "thread");
		if (!covered.length) return null;
		const cached = await readCachedSummary(db, keyOf(anchor, "thread", ""), null);
		const current = await coverageDigest(covered.map((message) => message.id));
		if (!cached.source || cached.source.coverageDigest !== current) return null;
		return { language: cached.source.language, ...storedContent(cached.source) };
	} catch (error) {
		if (error instanceof SummaryRefusal) return null;
		throw error;
	}
}
