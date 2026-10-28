import { and, desc, eq, gt, gte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, agentJobs, mailboxAgentSettings, mailboxes, messages, users } from "@/db/schema";
import { readMailboxAgentSettingsRow } from "../auto-read/mailbox-settings";
import { personalInstructionsFor } from "../user-ai-settings";
import { styleDescriptionFor } from "../writing-style";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { normalizeEmailAddress } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import { getAgentModel } from "../model";
import { getAgentEnabled } from "../provider";
import { recordAiUsage } from "@/lib/ai/usage";
import { claimAgentJob, failAndRequeueAgentJob, skipAgentJob } from "./lease";
import { runEmailTool } from "../tools";
import { notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { isAutomaticMessage } from "../auto-read/facts-utils";
import { generateReplyDraft, loadDraftThread } from "./draft-generation";
import { isCleanDraftBody } from "./draft-prompt-utils";
import { traceAiError } from "../ai-errors";
import { UnusableAnswerError } from "../ai-error-utils";
import { InteractiveModelRefusedError } from "../interactive-model";

export type AgentDraftQueueMessage = { kind: "agent.draft"; jobId: string };

export async function scheduleAutoDraft(
	env: CloudflareEnv,
	input: {
		mailboxId: string;
		sourceMessageId: string;
		ownerUserId: string;
		sender: string;
		headers?: Record<string, string>;
		status: string;
		folderId: string | null;
		spamVerdict?: string | null;
		spamAnalysisError?: string | null;
	},
) {
	if (
		input.status !== "received" ||
		input.folderId ||
		input.spamAnalysisError ||
		(input.spamVerdict && input.spamVerdict !== "inbox") ||
		isAutomaticMessage(input.sender, input.headers)
	)
		return;
	if (!(await getAgentEnabled(env))) return;
	const db = getDb(env);
	const settings = await readMailboxAgentSettingsRow(db, input.mailboxId);
	const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
	if (mailbox && (await getMailboxDomainAddresses(db, mailbox)).includes(normalizeEmailAddress(input.sender))) return;
	if (!settings?.autoDraftEnabled || mailbox?.autoReplyEnabled) return;
	const reviewerUserId = settings.reviewerUserId || input.ownerUserId;
	const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerUserId)).limit(1);
	if (!reviewer || reviewer.disabled || !(await getMailboxAccessLevel(db, reviewer, input.mailboxId))?.canSendOnBehalf)
		return;
	const jobId = newId("ajob");
	await db
		.insert(agentJobs)
		.values({ id: jobId, mailboxId: input.mailboxId, sourceMessageId: input.sourceMessageId, reviewerUserId })
		.onConflictDoNothing();
	const [job] = await db
		.select({ id: agentJobs.id, status: agentJobs.status })
		.from(agentJobs)
		.where(
			and(
				eq(agentJobs.mailboxId, input.mailboxId),
				eq(agentJobs.sourceMessageId, input.sourceMessageId),
				eq(agentJobs.kind, "draft"),
			),
		)
		.limit(1);
	if (job?.status === "pending") await env.AGENT_QUEUE?.send({ kind: "agent.draft", jobId: job.id });
}

export async function processAgentDraftJob(env: CloudflareEnv, jobId: string) {
	const db = getDb(env);
	const job = await claimAgentJob(db, jobId);
	if (job === "mailbox_busy") {
		await env.AGENT_QUEUE?.send({ kind: "agent.draft", jobId }, { delaySeconds: 5 });
		return;
	}
	if (!job) return;
	const skip = (reason: string) => skipAgentJob(db, jobId, reason);
	try {
		if (!(await getAgentEnabled(env))) return void (await skip("Assistant disabled"));
		const settings = await readMailboxAgentSettingsRow(db, job.mailboxId);
		const [source] = await db.select().from(messages).where(eq(messages.id, job.sourceMessageId)).limit(1);
		const [reviewer] = await db.select().from(users).where(eq(users.id, job.reviewerUserId)).limit(1);
		if (!settings?.autoDraftEnabled || !source || source.status !== "received" || !reviewer || reviewer.disabled)
			return void (await skip("Settings, source, or reviewer changed"));
		if (!(await getMailboxAccessLevel(db, reviewer, job.mailboxId))?.canSendOnBehalf)
			return void (await skip("Reviewer lost send permission"));
		const [mailbox] = await db
			.select({ autoReplyEnabled: mailboxes.autoReplyEnabled })
			.from(mailboxes)
			.where(eq(mailboxes.id, job.mailboxId))
			.limit(1);
		if (mailbox?.autoReplyEnabled) return void (await skip("Out-of-office reply is enabled"));
		const since = new Date();
		since.setUTCHours(0, 0, 0, 0);
		const [usage] = await db
			.select({ count: sql<number>`count(*)` })
			.from(agentJobs)
			.where(
				and(
					eq(agentJobs.mailboxId, job.mailboxId),
					eq(agentJobs.kind, "draft"),
					eq(agentJobs.status, "completed"),
					gte(agentJobs.createdAt, since),
				),
			);
		if ((usage?.count ?? 0) >= settings.dailyLimit) return void (await skip("Daily draft limit reached"));
		const [already] = await db
			.select({ draftId: agentDraftMetadata.draftId })
			.from(agentDraftMetadata)
			.where(eq(agentDraftMetadata.sourceMessageId, source.id))
			.limit(1);
		if (already) {
			await db
				.update(agentJobs)
				.set({ status: "completed", draftId: already.draftId, leaseUntil: null, completedAt: new Date() })
				.where(eq(agentJobs.id, jobId));
			return;
		}
		const [newer] = source.threadId
			? await db
					.select({ id: messages.id })
					.from(messages)
					.where(
						and(
							eq(messages.mailboxId, job.mailboxId),
							eq(messages.threadId, source.threadId),
							gt(messages.createdAt, source.createdAt),
							or(
								eq(messages.direction, "inbound"),
								and(eq(messages.direction, "outbound"), eq(messages.status, "sent")),
							),
						),
					)
					.orderBy(desc(messages.createdAt))
					.limit(1)
			: [];
		if (newer) return void (await skip("A newer message or sent reply superseded this draft"));
		const selection = await getAgentModel(env, settings.modelId);
		if (!selection) throw new InteractiveModelRefusedError("not_configured");
		const trace = { feature: "auto_draft" as const, model: selection.modelId, provider: selection.provider };
		const { text: body } = await generateReplyDraft({
			model: selection.model,
			instructions: settings.instructions,
			preferences: {
				mailboxDraft: settings.draftInstructions,
				personal: await personalInstructionsFor(db, reviewer),
				writingStyle: await styleDescriptionFor(db, reviewer.id, job.mailboxId),
			},
			thread: await loadDraftThread(env, job.mailboxId, source),
			onUsage: (usage) =>
				recordAiUsage({
					env,
					details: selection,
					usage,
					source: "auto_draft",
					mailboxId: job.mailboxId,
					jobId: job.id,
				}),
		}).catch((error: unknown) => {
			throw traceAiError(error, trace);
		});
		if (!isCleanDraftBody(body)) throw traceAiError(new UnusableAnswerError("it was not a clean draft"), trace);
		if (!(await getAgentEnabled(env))) return void (await skip("Assistant disabled during generation"));
		const [currentSettings] = await db
			.select({ autoDraftEnabled: mailboxAgentSettings.autoDraftEnabled })
			.from(mailboxAgentSettings)
			.where(eq(mailboxAgentSettings.mailboxId, job.mailboxId))
			.limit(1);
		if (!currentSettings?.autoDraftEnabled) return void (await skip("Auto-drafting was disabled during generation"));
		if (source.threadId) {
			const [latest] = await db
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.mailboxId, job.mailboxId),
						eq(messages.threadId, source.threadId),
						gt(messages.createdAt, source.createdAt),
						or(eq(messages.direction, "inbound"), and(eq(messages.direction, "outbound"), eq(messages.status, "sent"))),
					),
				)
				.orderBy(desc(messages.createdAt))
				.limit(1);
			if (latest) return void (await skip("A newer message or sent reply arrived during generation"));
		}
		const result = (await runEmailTool(
			{ env, user: reviewer, mailboxId: job.mailboxId, origin: "auto" },
			"draft_reply",
			{ emailId: source.id, body, replyAll: false },
		)) as { draftId: string };
		await db
			.update(agentJobs)
			.set({ status: "completed", draftId: result.draftId, leaseUntil: null, completedAt: new Date() })
			.where(eq(agentJobs.id, jobId));
		await notifyUsersOfNewMessage(env, [reviewer.id], {
			type: "agent_draft",
			mailboxId: job.mailboxId,
			draftId: result.draftId,
		});
	} catch (error) {
		await failAndRequeueAgentJob(env, db, job, error);
	}
}
