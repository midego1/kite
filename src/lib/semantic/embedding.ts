import { classifyAiError } from "@/lib/agent/ai-error-utils";
import { externalProviderRefused } from "@/lib/agent/external-provider";
import { getAgentEnabled } from "@/lib/agent/provider";
import { aiCallTimeoutMs, isAgentLoopbackAllowed, parseCustomAgentBaseUrl } from "@/lib/agent/provider-url-utils";
import { getSemanticCompatibleApiKey, getSemanticInstallSettings } from "./install-settings";

/** Fixed for every install (decision 15): a Vectorize index has a fixed dimension count. */
export const EMBEDDING_MODEL_ID = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
/** Workers AI accepts batches of up to this many texts per call. */
const BATCH_SIZE = 32;
/** A batch call gets this long before it gives up, so a hanging endpoint cannot hold a drain batch's lease. */
const EMBEDDING_CALL_TIMEOUT_MS = 30_000;

type EmbeddingResult = { vectors: Float32Array[]; inputTokens: number };

export type EmbeddingProvider = {
	/** `"compatible"` needs the external-provider opt-in; `"workers_ai"` (the binding or its REST API) does not. */
	kind: "workers_ai" | "compatible";
	model: typeof EMBEDDING_MODEL_ID;
	dimensions: typeof EMBEDDING_DIMENSIONS;
	embedTexts(texts: string[]): Promise<EmbeddingResult>;
};

export class EmbeddingProviderUnavailableError extends Error {
	constructor() {
		super("No embedding provider is configured");
		this.name = "EmbeddingProviderUnavailableError";
	}
}

export class EmbeddingDimensionMismatchError extends Error {
	constructor(got: number) {
		super(`Embedding provider returned ${got} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
		this.name = "EmbeddingDimensionMismatchError";
	}
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/** Workers AI does not report embedding token usage; this is the stand-in both the binding and its REST API use. */
function estimatedTokens(texts: readonly string[]): number {
	return texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
}

function toFloat32Vectors(data: number[][] | undefined): Float32Array[] {
	return (data ?? []).map((values) => {
		if (values.length !== EMBEDDING_DIMENSIONS) throw new EmbeddingDimensionMismatchError(values.length);
		return Float32Array.from(values);
	});
}

/** The binding has no abort signal of its own, so a call that never resolves is raced against this instead. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Embedding call timed out after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function embedWithBinding(ai: Ai, texts: string[], timeoutMs: number): Promise<EmbeddingResult> {
	const vectors: Float32Array[] = [];
	for (const batch of chunks(texts, BATCH_SIZE)) {
		const output = (await withTimeout(ai.run(EMBEDDING_MODEL_ID, { text: batch }), timeoutMs)) as {
			data?: number[][];
		};
		vectors.push(...toFloat32Vectors(output.data));
	}
	return { vectors, inputTokens: estimatedTokens(texts) };
}

async function embedWithWorkersAiRest(
	accountId: string,
	token: string,
	texts: string[],
	timeoutMs: number,
): Promise<EmbeddingResult> {
	const vectors: Float32Array[] = [];
	for (const batch of chunks(texts, BATCH_SIZE)) {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${EMBEDDING_MODEL_ID}`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ text: batch }),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		if (!response.ok) throw new Error(`Workers AI REST API answered ${response.status}`);
		const body = (await response.json()) as { result?: { data?: number[][] } };
		vectors.push(...toFloat32Vectors(body.result?.data));
	}
	return { vectors, inputTokens: estimatedTokens(texts) };
}

/** An OpenAI-compatible `/embeddings` endpoint serving bge-m3 (self-hosted Text Embeddings Inference, Ollama, ...). */
async function embedWithCompatible(
	baseUrl: string,
	apiKey: string | null,
	texts: string[],
	timeoutMs: number,
): Promise<EmbeddingResult> {
	const vectors: Float32Array[] = [];
	let inputTokens = 0;
	for (const batch of chunks(texts, BATCH_SIZE)) {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model: "bge-m3", input: batch }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error(`Compatible embeddings endpoint answered ${response.status}`);
		const body = (await response.json()) as {
			data?: { embedding: number[] }[];
			usage?: { prompt_tokens?: number };
		};
		vectors.push(...toFloat32Vectors(body.data?.map((item) => item.embedding)));
		inputTokens += typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : estimatedTokens(batch);
	}
	return { vectors, inputTokens };
}

/** The same HTTPS-only, no-credentials, no-query-string rule as a custom agent provider URL (`provider-url-utils.ts`). */
export function parseCompatibleEmbeddingBaseUrl(
	baseUrl: string,
	env: Pick<CloudflareEnv, "AI_ALLOW_INSECURE_LOOPBACK">,
): string {
	return parseCustomAgentBaseUrl(baseUrl, isAgentLoopbackAllowed(env.AI_ALLOW_INSECURE_LOOPBACK, process.env.NODE_ENV));
}

/**
 * Whether the configured embedding provider is Workers AI (the binding, or its REST API from Node — both count as
 * Cloudflare, per `docs/specs/semantic-search.md` section 9) or a compatible endpoint, without making a call. Used
 * to gate on the external-provider opt-in before `getEmbeddingProvider` is asked to actually embed anything.
 */
export async function resolvedEmbeddingProviderKind(
	env: Pick<CloudflareEnv, "AI" | "CF_ACCOUNT_ID" | "CF_TOKEN">,
): Promise<"workers_ai" | "compatible"> {
	if (env.AI) return "workers_ai";
	if (env.CF_ACCOUNT_ID && env.CF_TOKEN) return "workers_ai";
	return "compatible";
}

export type EmbeddingAvailability = { ok: true } | { ok: false; reason: string };

/**
 * Whether an embedding call may be made right now: `semantic_search_enabled`, the install kill switch, and for a
 * compatible provider the external-provider opt-in (re-checked on every call, since it can change between them) and
 * a configured endpoint. Shared by the indexing drain (`indexer.ts`) and query-time search (`search.ts`).
 */
export async function embeddingAvailability(env: CloudflareEnv): Promise<EmbeddingAvailability> {
	const [settings, agentEnabled] = await Promise.all([getSemanticInstallSettings(env), getAgentEnabled(env)]);
	if (!settings.enabled) return { ok: false, reason: "off" };
	if (!agentEnabled) return { ok: false, reason: "assistant_disabled" };
	const kind = await resolvedEmbeddingProviderKind(env);
	if (kind === "compatible") {
		if (await externalProviderRefused(env, "compatible")) return { ok: false, reason: "external_provider_not_allowed" };
		if (!settings.compatibleBaseUrl) return { ok: false, reason: "no_provider" };
	}
	return { ok: true };
}

/**
 * The embedding provider for this runtime: the `AI` binding on Workers, else (Node) the Workers AI REST API with
 * `CF_ACCOUNT_ID`/`CF_TOKEN`, else the admin-configured compatible endpoint. Throws
 * `EmbeddingProviderUnavailableError` when none is configured.
 */
export async function getEmbeddingProvider(env: CloudflareEnv): Promise<EmbeddingProvider> {
	const timeoutMs = aiCallTimeoutMs(env, process.env.NODE_ENV, EMBEDDING_CALL_TIMEOUT_MS);
	if (env.AI) {
		const ai = env.AI;
		return {
			kind: "workers_ai",
			model: EMBEDDING_MODEL_ID,
			dimensions: EMBEDDING_DIMENSIONS,
			embedTexts: (texts) => embedWithBinding(ai, texts, timeoutMs),
		};
	}
	if (env.CF_ACCOUNT_ID && env.CF_TOKEN) {
		const accountId = env.CF_ACCOUNT_ID;
		const token = env.CF_TOKEN;
		return {
			kind: "workers_ai",
			model: EMBEDDING_MODEL_ID,
			dimensions: EMBEDDING_DIMENSIONS,
			embedTexts: (texts) => embedWithWorkersAiRest(accountId, token, texts, timeoutMs),
		};
	}
	const settings = await getSemanticInstallSettings(env);
	if (settings.embeddingProvider === "compatible" && settings.compatibleBaseUrl) {
		// Re-validated here too: a URL saved under a different AI_ALLOW_INSECURE_LOOPBACK (an install moved to
		// production) or edited directly in the database must not quietly start sending mail content plaintext.
		let baseUrl: string;
		try {
			baseUrl = parseCompatibleEmbeddingBaseUrl(settings.compatibleBaseUrl, env);
		} catch {
			throw new EmbeddingProviderUnavailableError();
		}
		const { apiKey } = await getSemanticCompatibleApiKey(env);
		return {
			kind: "compatible",
			model: EMBEDDING_MODEL_ID,
			dimensions: EMBEDDING_DIMENSIONS,
			embedTexts: (texts) => embedWithCompatible(baseUrl, apiKey, texts, timeoutMs),
		};
	}
	throw new EmbeddingProviderUnavailableError();
}

/** The error code to store on a `message_embeddings` row, never the provider's own message (which can echo the text). */
export function embeddingErrorCode(error: unknown): string {
	return classifyAiError(error).code;
}
