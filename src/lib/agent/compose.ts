import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { streamText } from "ai";
import { getDb, type AppDatabase } from "@/db";
import { domains, messages } from "@/db/schema";
import { getEmailDisplayName } from "@/lib/email/address";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { getAutoReadInstallSettings } from "./auto-read/install-settings";
import { readMailboxAgentSettingsRow } from "./auto-read/mailbox-settings";
import { buildModelCallOptions } from "./auto-read/model-call-utils";
import { keepReservedEstimate, reconcileAiSpend, refusedSpendCap, reserveAiSpend } from "./auto-read/spend";
import type { ReserveAiSpendInput, SpendReservation } from "./auto-read/spend-types";
import { spendCapMessage } from "./chat-spend-utils";
import { checkComposeOutput } from "./compose-output-utils";
import { buildComposePrompt, composeMaxOutputTokens } from "./compose-prompt-utils";
import type { ComposeAction, ComposeMode, ComposeSource } from "./compose-types";
import { agentProviderErrorMessage } from "./errors";
import { selectInteractiveModel } from "./interactive-model";
import { personalInstructionsFor } from "./user-ai-settings";

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

/** A request refused before any model call, answered with its status. */
export class ComposeRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "ComposeRefusal";
	}
}

/**
 * The message being replied to, under the same rule as `get_email`: in this mailbox and never another user's draft.
 * A message the Screener holds is readable here because the user opened it to reply.
 */
async function loadSource(db: AppDatabase, user: SessionUser, request: ComposeRequest): Promise<ComposeSource | null> {
	const scope = eq(messages.mailboxId, request.mailboxId);
	const header = request.inReplyTo?.trim().replace(/^<|>$/g, "");
	let [row] = header
		? await db
				.select()
				.from(messages)
				.where(and(scope, inArray(messages.providerMessageId, [header, `<${header}>`])))
				.limit(1)
		: [];
	if (!row && request.threadId)
		[row] = await db
			.select()
			.from(messages)
			.where(and(scope, eq(messages.threadId, request.threadId), ne(messages.status, "draft")))
			.orderBy(desc(messages.createdAt))
			.limit(1);
	if (!row || (row.status === "draft" && row.userId !== user.id)) return null;
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
	const reservation = await reserveAiSpend(reserve);
	if (!reservation) {
		const cap = await refusedSpendCap(reserve);
		throw new ComposeRefusal(429, spendCapMessage(cap, { ...reserve, tokenCap: install.chatTokenCap }), "spend_cap");
	}
	const result = streamText({
		model: selection.model,
		system: prompt.system,
		messages: prompt.messages,
		maxOutputTokens,
		maxRetries: 0,
		providerOptions: options.providerOptions,
		abortSignal: signal,
		onError: () => undefined,
	});
	const references = [
		request.text,
		request.instruction,
		request.subject,
		...(request.to ?? []),
		source?.body,
		source?.from,
	];
	return streamComposeAnswer(env, result, reservation, selection.rates, {
		mode: request.mode,
		inputChars: request.text?.length ?? 0,
		references,
	});
}

function streamComposeAnswer(
	env: CloudflareEnv,
	result: ReturnType<typeof streamText>,
	reservation: SpendReservation,
	rates: ReserveAiSpendInput["details"]["rates"],
	check: Parameters<typeof checkComposeOutput>[1],
) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			let settled = false;
			try {
				let text = "";
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						text += part.text;
						emit({ type: "text", text: part.text });
					} else if (part.type === "error") throw part.error;
				}
				await reconcileAiSpend({ env, reservation, rates, usage: await result.totalUsage });
				settled = true;
				const outcome = checkComposeOutput(text, check);
				emit(
					outcome.ok
						? { type: "done", text: outcome.text, warnings: outcome.warnings }
						: { type: "error", error: outcome.error },
				);
			} catch (error) {
				emit({ type: "error", error: agentProviderErrorMessage(error) });
			} finally {
				// Aborted or failed before the provider reported usage: the estimate stays as the recorded spend.
				if (!settled) await keepReservedEstimate(env, reservation).catch(() => undefined);
				controller.close();
			}
		},
	});
}
