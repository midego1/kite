import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { streamText } from "ai";
import { getDb, type AppDatabase } from "@/db";
import { domains, messages } from "@/db/schema";
import { getEmailDisplayName } from "@/lib/email/address";
import { loadMessageBody } from "@/lib/email/bodies";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import type { SessionUser } from "@/lib/auth/types";
import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "./auto-read/mailbox-settings";
import { buildModelCallOptions, type ModelCallOptions } from "./auto-read/model-call-utils";
import { reportAiErrorClass, reportAiFailure, type AiFailureContext } from "./ai-errors";
import { classifyAiError, type AiErrorDetails } from "./ai-error-utils";
import { keepReservedEstimate, reconcileAiSpend, refusedSpendCap, reserveAiSpend } from "./auto-read/spend";
import type { ReserveAiSpendInput } from "./auto-read/spend-types";
import { spendCapMessage } from "./chat-spend-utils";
import { streamComposeAnswer } from "./compose-stream";
import { buildComposePrompt, composeMaxOutputTokens } from "./compose-prompt-utils";
import type { ComposeAction, ComposeMode, ComposeSource } from "./compose-types";
import { selectInteractiveModel } from "./interactive-model";
import { INTERACTIVE_THINKING_ROOM_TOKENS } from "./output-budget-utils";
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
async function loadSource(
	env: CloudflareEnv,
	user: SessionUser,
	request: ComposeRequest,
): Promise<ComposeSource | null> {
	const db = getDb(env);
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
	const { textBody, htmlBody } = await loadMessageBody(env, row, { textFirst: true });
	return {
		id: row.id,
		from: row.fromAddr,
		subject: row.subject ?? "",
		date: row.createdAt,
		body: textBody || htmlToReadableText(htmlBody),
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
 * returned stream (`streamComposeAnswer`) sends `text` deltas for the preview and one checked `done` text, or an
 * `error`; a cut-off first answer is asked once more with double the budget after a `restart` event. Nothing but the
 * `ai_usage` rows is stored.
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
	const selection = await selectInteractiveModel(env, { mailboxId: request.mailboxId, modelId: settings?.modelId });
	const source = request.mode === "write" ? await loadSource(env, user, request) : null;
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
		modelId: selection.modelId,
		// This request's own budget; a thinking request's room comes on top.
		answerTokens: composeMaxOutputTokens(request),
		thinkingRoomTokens: INTERACTIVE_THINKING_ROOM_TOKENS,
		reasoningEffort: selection.reasoningEffort,
	});
	const install = await getAutoReadInstallSettings(env);
	const reserveFor = (current: ModelCallOptions): ReserveAiSpendInput => ({
		env,
		details: selection,
		source: "compose",
		mailboxId: request.mailboxId,
		jobId: null,
		promptChars: prompt.system.length + prompt.messages[0].content.length,
		maxOutputTokens: current.maxOutputTokens,
		installCapMicros: install.dailySpendCapMicros,
		mailboxCapMicros: settings?.dailySpendCapMicros ?? null,
		tokenCap: install.chatTokenCap,
	});
	const failure: AiFailureContext = {
		env,
		feature: "compose",
		model: selection.modelId,
		provider: selection.provider,
		userId: user.id,
		mailboxId: request.mailboxId,
	};
	const refusedAtCap = async (reserve: ReserveAiSpendInput) => {
		const cap = await refusedSpendCap(reserve);
		const message = spendCapMessage(cap, { ...reserve, tokenCap: install.chatTokenCap });
		return reportAiErrorClass({ code: "spend_cap", status: null, message }, failure);
	};
	const reservation = await reserveAiSpend(reserveFor(options));
	if (!reservation) {
		const body = await refusedAtCap(reserveFor(options));
		throw new ComposeRefusal(429, body.error, body.code, body.details);
	}
	// One abort for the request and for a reader that cancels the stream, so either stops the provider call.
	const abort = new AbortController();
	signal?.addEventListener("abort", () => abort.abort(), { once: true });
	const send = (current: ModelCallOptions) =>
		streamText({
			model: selection.model,
			system: prompt.system,
			messages: prompt.messages,
			maxOutputTokens: current.maxOutputTokens,
			maxRetries: 0,
			providerOptions: current.providerOptions,
			abortSignal: abort.signal,
			onError: () => undefined,
		});
	// The subject and recipients are not references: a link in them would otherwise authorize itself.
	return streamComposeAnswer({
		abort,
		check: {
			mode: request.mode,
			input: (request.mode === "rewrite" ? request.text : request.instruction) ?? "",
			userReferences: [request.text, request.instruction],
			sourceReferences: [source?.body, source?.from],
		},
		first: { options, reservation },
		send,
		// The retry is a new request: reserved against the caps like the first.
		reserve: async (current) => {
			const next = await reserveAiSpend(reserveFor(current));
			return next ?? (await refusedAtCap(reserveFor(current)));
		},
		settle: (held, usage, outcome) =>
			reconcileAiSpend({ env, reservation: held, rates: selection.rates, usage, outcome }),
		keepEstimate: (held, outcome) => keepReservedEstimate(env, held, outcome),
		report: (failed, context) => reportAiErrorClass(failed, { ...failure, ...context }),
		reportError: (error, context) => reportAiFailure(error, { ...failure, ...context }),
		classify: classifyAiError,
	});
}
