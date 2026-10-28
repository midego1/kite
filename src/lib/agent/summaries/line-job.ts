import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { agentJobs, mailboxes, messages } from "@/db/schema";
import { claimAgentJob, failAndRequeueAgentJob, skipAgentJob } from "../jobs/lease";
import { getAgentProviderConfig } from "../provider";
import { ExternalProviderNotAllowedError, selectAutoReadModel } from "../auto-read/auto-read-model";
import { getAutoReadInstallSettings } from "../auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import {
	buildModelCallOptions,
	callWithFallback,
	chooseTriageModelId,
	completedText,
} from "../auto-read/model-call-utils";
import { allowAutoReadRequest } from "../auto-read/quota";
import { isPaused } from "../auto-read/schedule-utils";
import { resolveMailboxAgentSettings } from "../auto-read/settings-utils";
import { withReservedSpend } from "../auto-read/spend";
import { loadTriageContext } from "../auto-read/triage-context";
import { buildLinePrompt, cleanLine, LINE_MAX_OUTPUT_TOKENS } from "./line-utils";
import { lineGateFor, notifyLine, saveLine } from "./lines";
import { traceAiError } from "../ai-errors";
import { UnusableAnswerError } from "../ai-error-utils";

type AgentJobRow = typeof agentJobs.$inferSelect;
type Outcome = { skip: string } | { skip: null; line: string; modelId: string };

// Longer than any provider takes for one line, far shorter than the job's 10-minute lease.
const LINE_CALL_TIMEOUT_MS = 60_000;

/** Why the job stops before the model, or what it needs to ask it: the automatic-reading gates, then the line's. */
async function prepare(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow) {
	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled) return { skip: "assistant_disabled" } as const;
	if (!install.autoReadEnabled) return { skip: "kill_switch" } as const;
	const row = await readMailboxAgentSettingsRow(db, job.mailboxId);
	const [source] = await db.select().from(messages).where(eq(messages.id, job.sourceMessageId)).limit(1);
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, job.mailboxId)).limit(1);
	if (!row || !source || !mailbox) return { skip: "source_changed" } as const;
	if (isPaused(row.pausedUntil)) return { skip: "paused" } as const;
	const settings = resolveMailboxAgentSettings(row, {
		mailboxId: mailbox.id,
		ownerUserId: mailbox.userId,
		mailboxType: mailbox.type,
	});
	const context = await loadTriageContext(env, source, mailbox.userId);
	const gate = await lineGateFor(db, { settings, source, mailbox, facts: context.facts });
	if (gate) return { skip: gate } as const;
	return { skip: null, install, settings, source, mailbox, context } as const;
}

/** The one small request: the triage model, the external opt-in, the burst limit and a spend reservation. */
async function writeLine(
	env: CloudflareEnv,
	job: AgentJobRow,
	ready: Extract<Awaited<ReturnType<typeof prepare>>, { skip: null }>,
): Promise<Outcome> {
	const { install, settings, source, context } = ready;
	const config = await getAgentProviderConfig(env);
	if (config.provider === "compatible" && !install.externalAutoReadAllowed)
		return { skip: "external_provider_not_allowed" };
	if (!(await allowAutoReadRequest(env, job.mailboxId))) return { skip: "rate_limited" };
	const requested = chooseTriageModelId({
		triageModelId: settings.triageModelId,
		mailboxModelId: settings.modelId,
		models: config.models,
		// The saved rates, not Kite's price list: a Kite update must not move automatic reading to another model.
		rates: config.rates,
	});
	const prompt = buildLinePrompt({ messageId: source.id, subject: source.subject, body: context.bodyText });
	const selection = await selectAutoReadModel(env, requested);
	const options = buildModelCallOptions({
		provider: selection.providerKind,
		preset: selection.preset,
		kind: "draft",
		reasoningEffort: selection.reasoningEffort,
	});
	// The options' budget includes a reasoning model's headroom; keep it on top of the line's own.
	const base = { ...options, maxOutputTokens: LINE_MAX_OUTPUT_TOKENS + Math.max(0, options.maxOutputTokens - 900) };
	// A failure keeps the model and provider, so the job's failure handler reports it under the shared codes.
	const trace = {
		feature: "line_summary" as const,
		model: selection.modelId,
		provider: selection.provider,
		startedAt: Date.now(),
		timeoutMs: LINE_CALL_TIMEOUT_MS,
	};
	const reply = await callWithFallback(base, async (current) => {
		const model = await selectAutoReadModel(env, requested);
		return withReservedSpend(
			{
				env,
				details: model,
				source: "line_summary",
				mailboxId: job.mailboxId,
				jobId: job.id,
				promptChars: prompt.system.length + prompt.messages[0].content.length,
				maxOutputTokens: current.maxOutputTokens,
				installCapMicros: install.dailySpendCapMicros,
				mailboxCapMicros: settings.dailySpendCapMicros,
				tokenCap: install.autoReadTokenCap,
			},
			() =>
				generateText({
					model: model.model,
					system: prompt.system,
					messages: prompt.messages,
					maxOutputTokens: current.maxOutputTokens,
					providerOptions: current.providerOptions,
					maxRetries: 0,
					abortSignal: AbortSignal.timeout(LINE_CALL_TIMEOUT_MS),
				}),
		);
	}).catch((error: unknown) => {
		throw traceAiError(error, trace);
	});
	// A refusal before the call is a skip, never a recorded failure.
	if (!reply) return { skip: "spend_cap" };
	let text: string;
	try {
		text = completedText(reply);
	} catch (error) {
		throw traceAiError(error, { ...trace, finishReason: reply.finishReason, usage: reply.usage });
	}
	const line = cleanLine(text);
	// Like a draft that fails its checks: retried, then failed as `ai_error:unusable_answer`.
	if (!line) throw traceAiError(new UnusableAnswerError("it was not a usable one-line summary"), trace);
	return { skip: null, line, modelId: selection.modelId };
}

/**
 * Writes the one-line summary of a message automatic reading did not read with the model. It runs under the
 * automatic-reading rules (assistant and install switch, pause, external opt-in, burst limit, the mailbox and
 * install spend caps) and the line's own gate, and records a skip reason when any of them refuses. A failed request
 * is retried and reported under the shared AI error codes (`ai_error:<code>` on the job, Admin → Agent's list).
 */
export async function processLineSummaryJob(env: CloudflareEnv, jobId: string) {
	const db = getDb(env);
	const job = await claimAgentJob(db, jobId);
	if (job === "mailbox_busy") {
		await env.AGENT_QUEUE?.send({ kind: "agent.line_summary", jobId }, { delaySeconds: 5 });
		return;
	}
	if (!job) return;
	try {
		const ready = await prepare(env, db, job);
		if (ready.skip !== null) return void (await skipAgentJob(db, jobId, ready.skip));
		const outcome = await writeLine(env, job, ready);
		if (outcome.skip !== null) return void (await skipAgentJob(db, jobId, outcome.skip));
		const line = { source: ready.source, text: outcome.line, from: "line_job" as const, modelId: outcome.modelId };
		if (await saveLine(env.DB, line)) await notifyLine(env, ready.mailbox, ready.source.id);
		await db
			.update(agentJobs)
			.set({ status: "completed", leaseUntil: null, completedAt: new Date(), reason: null })
			.where(eq(agentJobs.id, jobId));
	} catch (error) {
		if (error instanceof ExternalProviderNotAllowedError)
			return void (await skipAgentJob(db, jobId, "external_provider_not_allowed"));
		await failAndRequeueAgentJob(env, db, job, error);
	}
}
