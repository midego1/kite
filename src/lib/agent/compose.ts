import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { streamText } from "ai";
import { getDb, type AppDatabase } from "@/db";
import { domains, messages } from "@/db/schema";
import { getEmailDisplayName } from "@/lib/email/address";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import type { SessionUser } from "@/lib/auth/types";
import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "./auto-read/mailbox-settings";
import { buildModelCallOptions } from "./auto-read/model-call-utils";
import { reportAiErrorClass, reportAiFailure, type AiFailureContext } from "./ai-errors";
import type { AiErrorDetails } from "./ai-error-utils";
import { keepReservedEstimate, reconcileAiSpend, refusedSpendCap, reserveAiSpend } from "./auto-read/spend";
import type { ReserveAiSpendInput, SpendReservation } from "./auto-read/spend-types";
import { spendCapMessage } from "./chat-spend-utils";
import { checkComposeOutput } from "./compose-output-utils";
import { buildComposePrompt, composeMaxOutputTokens } from "./compose-prompt-utils";
import type { ComposeAction, ComposeMode, ComposeSource } from "./compose-types";
import { selectInteractiveModel } from "./interactive-model";
import { personalInstructionsFor } from "./user-ai-settings";
import { styleDescriptionFor } from "./writing-style";

export type ComposeRequest = {
	mailboxId: string;
	mode: ComposeMode;
	action?: ComposeAction;
	instruction?: string;
	language?: string;
	text?: string;
	subject?: string;
	to?: string[];
	/** The reply's `In-Reply-To` and thread; the server loads that message itself. */
	inReplyTo?: string | null;
	threadId?: string | null;
};

/** A request refused before any model call, answered with its status (and the details of an AI refusal). */
export class ComposeRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
		readonly details?: AiErrorDetails,
	) {
		super(message);
		this.name = "ComposeRefusal";
	}
}

// Mail Kite holds or has set aside is never the email a reply answers: the Screener's held mail, spam and trash.
const NOT_A_SOURCE = [SCREENING_STATUS, "spam", "trash"];

/**
 * The message being replied to: in this mailbox, not held by the Screener, in spam or in trash, and never another
 * user's draft (all filtered in SQL). When a Message-ID is stored twice (a copy in Sent and the one received), the
 * received copy wins, then the newest; without a Message-ID match the newest received message of the thread.
 */
async function loadSource(db: AppDatabase, user: SessionUser, request: ComposeRequest): Promise<ComposeSource | null> {
	const allowed = and(
		eq(messages.mailboxId, request.mailboxId),
		notInArray(messages.status, NOT_A_SOURCE),
		or(ne(messages.status, "draft"), eq(messages.userId, user.id)),
	);
	const preference = [desc(sql`${messages.direction} = 'inbound'`), desc(messages.createdAt)];
	const header = request.inReplyTo?.trim().replace(/^<|>$/g, "");
	let [row] = header
		? await db
				.select()
				.from(messages)
				.where(and(allowed, inArray(messages.providerMessageId, [header, `<${header}>`])))
				.orderBy(...preference)
				.limit(1)
		: [];
	if (!row && request.threadId)
		[row] = await db
			.select()
			.from(messages)
			.where(and(allowed, eq(messages.threadId, request.threadId), ne(messages.status, "draft")))
			.orderBy(...preference)
			.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		from: row.fromAddr,
		subject: row.subject ?? "",
		date: row.createdAt,
		body: row.textBody || htmlToReadableText(row.htmlBody),
	};
}

async function mailboxAddress(db: AppDatabase, mailbox: { localPart: string; domainId: string }) {
	const [domain] = await db
		.select({ hostname: domains.hostname })
		.from(domains)
		.where(eq(domains.id, mailbox.domainId))
		.limit(1);
	return domain ? `${mailbox.localPart}@${domain.hostname}` : mailbox.localPart;
}

/**
 * The user's writing style for this request: none to fix spelling or translate, which must keep the text's own voice,
 * and without the formality line when they asked for more formal or more casual text.
 */
function composeWritingStyle(db: AppDatabase, userId: string, request: ComposeRequest): Promise<string | null> {
	if (request.mode === "rewrite" && (request.action === "grammar" || request.action === "translate"))
		return Promise.resolve(null);
	const withoutFormality = request.action === "formal" || request.action === "casual";
	return styleDescriptionFor(db, userId, request.mailboxId, { withoutFormality });
}

const recipientNames = (to: string[] = []) =>
	to.map((value) => (value.includes("<") ? getEmailDisplayName(value) : "")).filter(Boolean);

/**
 * Prepares one composer request: mailbox access (404 so ids do not leak), the email being answered, the model with
 * the external opt-in checked again, the prompt and a spend reservation against the mailbox and install caps. The
 * returned stream sends `text` deltas for the preview and one checked `done` text, or an `error`; nothing but the
 * `ai_usage` row is stored.
 */
export async function createComposeStream(
	env: CloudflareEnv,
	user: SessionUser,
	request: ComposeRequest,
	signal?: AbortSignal,
) {
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, request.mailboxId);
	if (!access?.canSendOnBehalf) throw new ComposeRefusal(404, "Mailbox not found");
	const settings = await readMailboxAgentSettingsRow(db, request.mailboxId);
	const selection = await selectInteractiveModel(env, settings?.modelId);
	const source = request.mode === "write" ? await loadSource(db, user, request) : null;
	const prompt = buildComposePrompt({
		...request,
		recipientNames: recipientNames(request.to),
		source,
		userName: user.name,
		mailboxAddress: await mailboxAddress(db, access.mailbox),
		instructions: { general: settings?.instructions ?? "", draft: settings?.draftInstructions ?? "" },
		personal: await personalInstructionsFor(db, user),
		writingStyle: await composeWritingStyle(db, user.id, request),
	});
	const options = buildModelCallOptions({
		provider: selection.providerKind,
		preset: selection.preset,
		kind: "draft",
		reasoningEffort: selection.reasoningEffort,
	});
	// The options' budget includes the reasoning headroom of a reasoning model; keep it on top of this request's own.
	const maxOutputTokens = composeMaxOutputTokens(request) + Math.max(0, options.maxOutputTokens - 900);
	const install = await getAutoReadInstallSettings(env);
	const reserve: ReserveAiSpendInput = {
		env,
		details: selection,
		source: "compose",
		mailboxId: request.mailboxId,
		jobId: null,
		promptChars: prompt.system.length + prompt.messages[0].content.length,
		maxOutputTokens,
		installCapMicros: install.dailySpendCapMicros,
		mailboxCapMicros: settings?.dailySpendCapMicros ?? null,
		tokenCap: install.chatTokenCap,
	};
	const failure: AiFailureContext = {
		env,
		feature: "compose",
		model: selection.modelId,
		provider: selection.provider,
		userId: user.id,
		mailboxId: request.mailboxId,
	};
	const reservation = await reserveAiSpend(reserve);
	if (!reservation) {
		const cap = await refusedSpendCap(reserve);
		const message = spendCapMessage(cap, { ...reserve, tokenCap: install.chatTokenCap });
		const body = await reportAiErrorClass({ code: "spend_cap", status: null, message }, failure);
		throw new ComposeRefusal(429, body.error, body.code, body.details);
	}
	// One abort for the request and for a reader that cancels the stream, so either stops the provider call.
	const abort = new AbortController();
	signal?.addEventListener("abort", () => abort.abort(), { once: true });
	const result = streamText({
		model: selection.model,
		system: prompt.system,
		messages: prompt.messages,
		maxOutputTokens,
		maxRetries: 0,
		providerOptions: options.providerOptions,
		abortSignal: abort.signal,
		onError: () => undefined,
	});
	// The subject and recipients are not references: a link in them would otherwise authorize itself.
	return streamComposeAnswer(env, result, reservation, selection.rates, abort, failure, {
		mode: request.mode,
		input: (request.mode === "rewrite" ? request.text : request.instruction) ?? "",
		userReferences: [request.text, request.instruction],
		sourceReferences: [source?.body, source?.from],
	});
}

function streamComposeAnswer(
	env: CloudflareEnv,
	result: ReturnType<typeof streamText>,
	reservation: SpendReservation,
	rates: ReserveAiSpendInput["details"]["rates"],
	abort: AbortController,
	failure: AiFailureContext,
	check: Parameters<typeof checkComposeOutput>[1],
) {
	const startedAt = Date.now();
	const encoder = new TextEncoder();
	let closed = false;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// Nothing is written after the reader cancelled.
			const emit = (event: unknown) => {
				if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			};
			let settled = false;
			let usage: Awaited<typeof result.totalUsage> | null = null;
			// The client gets a fixed message, a code and the details; the provider's own text, which may echo
			// content, is neither sent nor logged.
			const fail = async (body: ReturnType<typeof reportAiFailure>) => emit({ type: "error", ...(await body) });
			const context = () => ({ ...failure, startedAt, usage });
			try {
				let text = "";
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						text += part.text;
						emit({ type: "text", text: part.text });
					} else if (part.type === "error") throw part.error;
				}
				if (abort.signal.aborted) return;
				usage = await result.totalUsage;
				await reconcileAiSpend({ env, reservation, rates, usage });
				settled = true;
				// An answer that ran out of tokens ends mid-sentence; none of it may be inserted.
				if ((await result.finishReason) === "length")
					return await fail(
						reportAiErrorClass({ code: "cut_off", status: null }, { ...context(), finishReason: "length" }),
					);
				const outcome = checkComposeOutput(text, check);
				if (outcome.ok) emit({ type: "done", text: outcome.text, warnings: outcome.warnings });
				else
					await fail(reportAiErrorClass({ code: "unusable_answer", status: null, reason: outcome.error }, context()));
			} catch (error) {
				if (!abort.signal.aborted) await fail(reportAiFailure(error, context()));
			} finally {
				// Aborted, cancelled or failed before the provider reported usage: the estimate stays as the spend.
				if (!settled) await keepReservedEstimate(env, reservation).catch(() => undefined);
				if (!closed) controller.close();
				closed = true;
			}
		},
		cancel() {
			closed = true;
			abort.abort();
		},
	});
}
