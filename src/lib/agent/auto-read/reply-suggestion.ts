import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { draftPromptChars, generateReplyDraft, loadDraftThread } from "../jobs/draft-generation";
import type { PersonalInstructions } from "../instruction-types";
import { personalInstructionsFor } from "../user-ai-settings";
import { styleDescriptionFor } from "../writing-style";
import { draftReplyEffect } from "./action-effects";
import { ExternalProviderNotAllowedError, selectAutoReadModel } from "./auto-read-model";
import { guardDraft, collectThreadReferences } from "./draft-guard-utils";
import { executeAction, recordBlockedAction } from "./execute";
import type { MessageFacts } from "./facts-types";
import { buildModelCallOptions, callWithFallback, completedText } from "./model-call-utils";
import type { MailboxAgentSettingsState } from "./settings-types";
import { withReservedSpend } from "./spend";
import type { PlannedSuggestion } from "./suggestion-types";
import { upsertSuggestion } from "./suggestions";
import { SpendCapReachedError } from "./triage-run";

// Same bound as a triage call: well inside the job's 10-minute lease.
const DRAFT_CALL_TIMEOUT_MS = 60_000;

type SourceMessage = typeof messages.$inferSelect;
type AgentSelection = Awaited<ReturnType<typeof selectAutoReadModel>>;

type ReplySuggestionInput = {
	env: CloudflareEnv;
	job: { id: string; mailboxId: string; reviewerUserId: string };
	source: SourceMessage;
	settings: MailboxAgentSettingsState;
	facts: MessageFacts;
	suggestion: PlannedSuggestion;
	/** The triage model that decided a reply is needed. */
	model: string | null;
	installCapMicros: number;
	/** Automatic reading's daily input-token allowance, used without model rates. */
	tokenCap: number;
};

/**
 * One draft request; its estimated cost is reserved first (source auto_draft, the triage job's ids). The prompt
 * carries the mailbox's drafting instructions and, when given, the reviewer's own.
 */
export async function generateDraft(
	input: Pick<ReplySuggestionInput, "env" | "job" | "settings" | "installCapMicros" | "tokenCap">,
	selection: AgentSelection,
	thread: SourceMessage[],
	personal: PersonalInstructions | null = null,
	writingStyle: string | null = null,
) {
	const { env, job, settings } = input;
	const preferences = { mailboxDraft: settings.draftInstructions, personal, writingStyle };
	const promptChars = draftPromptChars({ instructions: settings.instructions, preferences, thread });
	const options = buildModelCallOptions({
		provider: selection.providerKind,
		kind: "draft",
		reasoningEffort: selection.reasoningEffort,
	});
	const generated = await callWithFallback(options, async (current) => {
		// A parameter fallback is a new request, so the opt-in is checked again.
		const model = await selectAutoReadModel(env, settings.modelId);
		const reply = await withReservedSpend(
			{
				env,
				details: model,
				source: "auto_draft",
				mailboxId: job.mailboxId,
				jobId: job.id,
				promptChars,
				maxOutputTokens: current.maxOutputTokens,
				installCapMicros: input.installCapMicros,
				tokenCap: input.tokenCap,
				mailboxCapMicros: settings.dailySpendCapMicros,
			},
			() =>
				generateReplyDraft({
					model: model.model,
					instructions: settings.instructions,
					preferences,
					thread,
					maxOutputTokens: current.maxOutputTokens,
					providerOptions: current.providerOptions,
					maxRetries: 0,
					abortSignal: AbortSignal.timeout(DRAFT_CALL_TIMEOUT_MS),
				}),
		);
		if (!reply) throw new SpendCapReachedError();
		return reply;
	});
	return completedText(generated).trim();
}

function threadReferences(thread: SourceMessage[]) {
	return collectThreadReferences(
		thread.flatMap((row) => [row.textBody, row.htmlBody, row.fromAddr, row.toAddr, row.ccAddr]),
	);
}

function blockDraft(input: ReplySuggestionInput, reason: string, before?: unknown) {
	return recordBlockedAction({
		env: input.env,
		mailboxId: input.job.mailboxId,
		messageId: input.source.id,
		jobId: input.job.id,
		action: "create_draft",
		initiator: "agent",
		actingUserId: input.job.reviewerUserId,
		autonomy: input.settings.autonomy,
		reason,
		before,
	});
}

/** Removes a reply suggestion that never got its draft, so no card points at a missing draft. */
async function dropDraftlessSuggestion(env: CloudflareEnv, suggestionId: string) {
	await getDb(env)
		.delete(agentSuggestions)
		.where(and(eq(agentSuggestions.id, suggestionId), isNull(agentSuggestions.draftId)));
}

async function existingReply(env: CloudflareEnv, messageId: string) {
	const [row] = await getDb(env)
		.select({ status: agentSuggestions.status, draftId: agentSuggestions.draftId })
		.from(agentSuggestions)
		.where(and(eq(agentSuggestions.messageId, messageId), eq(agentSuggestions.kind, "reply")))
		.limit(1);
	return row ?? null;
}

/** The draft model, or null after recording that the provider may not read this mail. */
async function draftModel(input: ReplySuggestionInput): Promise<AgentSelection | null> {
	try {
		return await selectAutoReadModel(input.env, input.settings.modelId);
	} catch (error) {
		if (!(error instanceof ExternalProviderNotAllowedError)) throw error;
		await blockDraft(input, "external_provider_not_allowed");
		return null;
	}
}

/** Generates a guarded draft and returns its text, or null after recording why no draft is made. */
async function guardedDraftText(
	input: ReplySuggestionInput,
	selection: AgentSelection,
	reviewer: { id: string; name: string },
): Promise<string | null> {
	const db = getDb(input.env);
	const thread = await loadDraftThread(db, input.job.mailboxId, input.source);
	let text: string;
	try {
		text = await generateDraft(
			input,
			selection,
			thread,
			await personalInstructionsFor(db, reviewer),
			await styleDescriptionFor(db, reviewer.id, input.job.mailboxId),
		);
	} catch (error) {
		if (error instanceof SpendCapReachedError) {
			await blockDraft(input, "spend_cap");
			return null;
		}
		if (!(error instanceof ExternalProviderNotAllowedError)) throw error;
		await blockDraft(input, "external_provider_not_allowed");
		return null;
	}
	const guarded = guardDraft(text, threadReferences(thread));
	if (guarded.ok) return guarded.text;
	// Only the rule is kept; the rejected text and the address or URL it carried are not stored.
	await blockDraft(input, "draft_guard", { guard: guarded.reason });
	return null;
}

/**
 * Turns a planned reply into a reply suggestion with an agent draft. The draft is generated with
 * the shared auto-draft prompt, checked by the draft guard and saved through the executor as an
 * agent-initiated `create_draft` action. A rejected draft creates no suggestion, only a blocked row.
 */
export async function createReplySuggestion(input: ReplySuggestionInput): Promise<void> {
	const { env, job, source, settings } = input;
	const previous = await existingReply(env, source.id);
	if (previous && (previous.status !== "open" || previous.draftId)) return;
	const [reviewer] = await getDb(env).select().from(users).where(eq(users.id, job.reviewerUserId)).limit(1);
	if (!reviewer || reviewer.disabled) return;
	const selection = await draftModel(input);
	if (!selection) return;
	const body = await guardedDraftText(input, selection, reviewer);
	if (body === null) return;
	const stored = await upsertSuggestion({ env, job, source, model: input.model }, input.suggestion);
	if (!stored || stored.status !== "open" || stored.draftId) return;
	const result = await executeAction({
		env,
		mailboxId: job.mailboxId,
		suggestionId: stored.id,
		messageId: source.id,
		jobId: job.id,
		action: "create_draft",
		actingUserId: reviewer.id,
		autonomy: settings.autonomy,
		initiator: "agent",
		gate: {
			level: settings.autonomy,
			facts: input.facts,
			senderPolicy: null,
			context: { capabilities: settings.capabilities, fullAutoAllowed: false },
		},
		effect: draftReplyEffect({ env, reviewer, mailboxId: job.mailboxId, sourceMessageId: source.id, body }),
	});
	const draftId = result.after?.draftId;
	if ((result.status === "applied" || result.status === "skipped") && typeof draftId === "string") {
		await getDb(env).update(agentSuggestions).set({ draftId }).where(eq(agentSuggestions.id, stored.id));
		return;
	}
	await dropDraftlessSuggestion(env, stored.id);
	if (result.status === "failed") throw new Error(result.reason ?? "The reply draft could not be saved");
}
