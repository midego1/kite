import { and, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import type { LanguageModelUsage } from "ai";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxes, users } from "@/db/schema";
import { createLogger } from "@/lib/logger.mjs";
import { createAuditLog } from "@/lib/mailboxes/audit";
import {
	AI_FEATURE_LABELS,
	aiErrorIsConfig,
	aiErrorIsRefusal,
	aiErrorMessage,
	aiErrorRetryable,
	classifyAiError,
	isAiErrorCode,
	type AiErrorBody,
	type AiErrorClass,
	type AiErrorCode,
	type AiFeature,
} from "./ai-error-utils";
import type { AiErrorRecord, RecentAiError } from "./ai-error-types";
import type { AiFailureRow } from "./ai-failure-report-utils";
import { readAiOutputBudget } from "./output-budget-utils";

const logger = createLogger("agent");

/** The audit action of a failed AI request; only Admin → Agent lists it. */
const AI_ERROR_ACTION = "ai.error";
/** Older failures are deleted when a new one is recorded, so the list never grows. */
export const AI_ERRORS_KEPT = 200;
const RECENT_AI_ERRORS = 20;

export type AiFailureContext = {
	env: CloudflareEnv;
	feature: AiFeature;
	model?: string | null;
	provider?: string | null;
	/** `Date.now()` when the request started, for the duration. */
	startedAt?: number;
	usage?: Partial<Pick<LanguageModelUsage, "inputTokens" | "outputTokens">> | null;
	finishReason?: string | null;
	timeoutMs?: number | null;
	userId?: string | null;
	mailboxId?: string | null;
	/** False to skip the row for Admin → Agent (a turn the person stopped); refusals are never kept. */
	record?: boolean;
};

type AiErrorMetadata = AiErrorRecord;

async function recordAiError(context: AiFailureContext, metadata: AiErrorMetadata) {
	const db = getDb(context.env);
	await createAuditLog(context.env, {
		actorUserId: context.userId ?? null,
		mailboxId: context.mailboxId ?? null,
		action: AI_ERROR_ACTION,
		metadata,
	});
	const kept = db
		.select({ id: auditLogs.id })
		.from(auditLogs)
		.where(eq(auditLogs.action, AI_ERROR_ACTION))
		.orderBy(desc(auditLogs.createdAt))
		.limit(AI_ERRORS_KEPT);
	await db.delete(auditLogs).where(and(eq(auditLogs.action, AI_ERROR_ACTION), notInArray(auditLogs.id, kept)));
}

type AiTrace = Partial<Omit<AiFailureContext, "env" | "record">> & { reported?: AiErrorBody };

// What the code that made a request knew about it, for the code that catches the error further up (a job's retry).
const traces = new WeakMap<object, AiTrace>();

/**
 * Notes the model, provider and feature of a failed request on its error and returns the error, for code that
 * rethrows it: whoever reports it later (the agent job's failure handler) names the model that failed.
 */
export function traceAiError<T>(error: T, trace: Omit<AiTrace, "reported">): T {
	if (error && typeof error === "object") traces.set(error, { ...trace, ...traces.get(error) });
	return error;
}

/**
 * Logs one failed AI request (code, feature, model, provider, duration, token counts and finish reason; never the
 * prompt, the answer or the provider's error text), keeps it for Admin → Agent and returns what the client gets.
 * An error that was already reported (a job rethrows what it reported) is not logged twice.
 */
const REFUSAL_LOG_INTERVAL_MS = 60_000;
const REFUSAL_LOG_KEYS_MAX = 1_000;
// When each user's refusal was last logged in this isolate, per code and feature.
const refusalsLogged = new Map<string, number>();

/** Whether to log a refusal: at most once a minute per user, code and feature, so a spammed button logs once. */
function shouldLogRefusal(context: AiFailureContext, code: AiErrorCode, now = Date.now()): boolean {
	const key = `${context.userId ?? "-"}:${code}:${context.feature}`;
	const last = refusalsLogged.get(key);
	if (last !== undefined && now - last < REFUSAL_LOG_INTERVAL_MS) return false;
	if (refusalsLogged.size >= REFUSAL_LOG_KEYS_MAX) refusalsLogged.clear();
	refusalsLogged.set(key, now);
	return true;
}

export async function reportAiFailure(error: unknown, context: AiFailureContext): Promise<AiErrorBody> {
	const trace = error && typeof error === "object" ? traces.get(error) : undefined;
	if (trace?.reported) return trace.reported;
	const body = await reportAiErrorClass(classifyAiError(error), { ...context, ...definedOf(trace) });
	if (error && typeof error === "object") traces.set(error, { ...trace, reported: body });
	return body;
}

function definedOf(trace: AiTrace | undefined): Partial<AiFailureContext> {
	if (!trace) return {};
	const { reported: _reported, ...rest } = trace;
	return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null));
}

/** `reportAiFailure` for a failure Kite already classified, such as a cut-off answer or a spend cap. */
export async function reportAiErrorClass(
	failure: AiErrorClass & { message?: string },
	context: AiFailureContext,
): Promise<AiErrorBody> {
	const { code, status } = failure;
	const metadata: AiErrorMetadata = {
		code,
		feature: context.feature,
		model: context.model ?? null,
		provider: context.provider ?? null,
		status,
		durationMs: context.startedAt ? Date.now() - context.startedAt : null,
		inputTokens: context.usage?.inputTokens ?? null,
		outputTokens: context.usage?.outputTokens ?? null,
		finishReason: context.finishReason ?? null,
		...(failure.budget ? { budget: failure.budget } : {}),
	};
	// A refusal before any provider call (a cap, a rate limit, a setting) is no provider or model failure: it is
	// logged at most once a minute per user and never kept, so a spammed button neither writes to D1 on every
	// request nor pushes real failures out of the list.
	const refusal = aiErrorIsRefusal(code);
	// Token counts are nested: the logger redacts any key containing "token".
	const { inputTokens, outputTokens, ...fields } = metadata;
	if (!refusal || shouldLogRefusal(context, code))
		logger.warn("ai.failed", { ...fields, usage: { input: inputTokens, output: outputTokens } });
	if (!refusal && context.record !== false)
		await recordAiError(context, metadata).catch(() => logger.warn("ai.failed_unrecorded", { code }));
	return {
		error:
			failure.message ?? aiErrorMessage(code, { timeoutMs: context.timeoutMs, status, reason: failure.reason ?? null }),
		code,
		details: {
			code,
			feature: context.feature,
			model: metadata.model,
			provider: metadata.provider,
			status,
			at: new Date().toISOString(),
			retryable: aiErrorRetryable(code),
			config: aiErrorIsConfig(code),
		},
	};
}

function budgetOf(raw: unknown): Pick<AiErrorMetadata, "budget"> {
	const budget = readAiOutputBudget(raw);
	return budget ? { budget } : {};
}

function parseMetadata(raw: string | null): AiErrorMetadata | null {
	try {
		const value = JSON.parse(raw ?? "null") as Partial<AiErrorMetadata> | null;
		if (!value || !isAiErrorCode(value.code)) return null;
		const number = (item: unknown) => (typeof item === "number" ? item : null);
		const text = (item: unknown) => (typeof item === "string" ? item : null);
		return {
			code: value.code,
			feature: (value.feature && value.feature in AI_FEATURE_LABELS ? value.feature : "chat") as AiFeature,
			model: text(value.model),
			provider: text(value.provider),
			status: number(value.status),
			durationMs: number(value.durationMs),
			inputTokens: number(value.inputTokens),
			outputTokens: number(value.outputTokens),
			finishReason: text(value.finishReason),
			...budgetOf(value.budget),
		};
	} catch {
		return null;
	}
}

/** The newest recorded AI failures for Admin → Agent: codes and numbers only, no content. */
export async function listRecentAiErrors(env: CloudflareEnv, limit = RECENT_AI_ERRORS): Promise<RecentAiError[]> {
	const rows = await getDb(env)
		.select({
			id: auditLogs.id,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			user: users.email,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.leftJoin(mailboxes, eq(mailboxes.id, auditLogs.mailboxId))
		.leftJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(auditLogs.action, AI_ERROR_ACTION))
		.orderBy(desc(auditLogs.createdAt), sql`"audit_logs"."rowid" desc`)
		.limit(limit);
	return rows.flatMap((row) => {
		const metadata = parseMetadata(row.metadata);
		if (!metadata) return [];
		return [
			{
				...metadata,
				id: row.id,
				at: row.createdAt.toISOString(),
				featureLabel: AI_FEATURE_LABELS[metadata.feature],
				user: row.user ?? null,
				mailbox: row.localPart ? (row.hostname ? `${row.localPart}@${row.hostname}` : row.localPart) : null,
			},
		];
	});
}

/**
 * The failures recorded since `since`, newest first and at most the kept number: the metadata and the time only,
 * never who or which mailbox. One indexed read of `audit_logs`, which every schema version has.
 */
export async function listAiFailuresSince(env: CloudflareEnv, since: Date): Promise<AiFailureRow[]> {
	const rows = await getDb(env)
		.select({ metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
		.from(auditLogs)
		.where(and(eq(auditLogs.action, AI_ERROR_ACTION), gte(auditLogs.createdAt, since)))
		.orderBy(desc(auditLogs.createdAt))
		.limit(AI_ERRORS_KEPT);
	return rows.flatMap((row) => {
		const metadata = parseMetadata(row.metadata);
		if (!metadata) return [];
		const { code, feature, model, provider, status, budget } = metadata;
		return [{ code, feature, model, provider, status, budget: budget ?? null, at: row.createdAt.toISOString() }];
	});
}
