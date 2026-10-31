import { AI_FEATURE_LABELS, aiErrorMessage, type AiErrorCode } from "./ai-error-utils";
import type { AiErrorRecord } from "./ai-error-types";
import type { AiFailureGroup, AiFailureLink, AskAiState } from "./ai-failure-report-types";
import { defaultAgentProviderName } from "./provider-connection-utils";
import type { AgentProviderPreset } from "./provider-types";

/** One recorded failure as the report reads it: the `ai.error` audit row's metadata and its time. */
export type AiFailureRow = Pick<AiErrorRecord, "code" | "feature" | "model" | "provider" | "status"> & { at: string };

const PRESETS: AgentProviderPreset[] = ["haimaker", "anthropic", "openai", "openrouter", "groq", "custom"];

/** The name of a recorded provider (`cloudflare` or a preset id), as Admin → Agent names it. */
export function aiProviderLabel(provider: string | null): string | null {
	if (!provider) return null;
	if (provider === "cloudflare") return defaultAgentProviderName("cloudflare", null);
	if ((PRESETS as string[]).includes(provider))
		return defaultAgentProviderName("compatible", provider as AgentProviderPreset);
	return provider === "compatible" ? "External provider" : provider;
}

const PROVIDER_SETTINGS: AiFailureLink = { href: "/agent#ai-provider", label: "Open AI provider settings" };
const READING_SETTINGS: AiFailureLink = { href: "/agent#automatic-reading", label: "Open automatic reading settings" };
const USAGE: AiFailureLink = { href: "/ai-usage", label: "Open AI usage" };
const RECENT_ERRORS: AiFailureLink = { href: "/agent#recent-ai-errors", label: "Open Recent AI errors" };

type ExplainInput = { provider: string; status: number | null };
type Explanation = { cause: string; fix: string; link: AiFailureLink | null };

const http = (status: number | null) => (status ? ` (HTTP ${status})` : "");

/** The likely cause and the fix of each code, naming the provider. Every code has one, so a new code cannot slip by. */
const EXPLANATIONS: Record<AiErrorCode, (input: ExplainInput) => Explanation> = {
	provider_auth: ({ provider, status }) => ({
		cause: `${provider} refused Kite's API key${http(status)}. The key was revoked, expired, mistyped or has no credit left.`,
		fix: `Create a new key at ${provider}, then paste it into the provider in Admin → Agent and save.`,
		link: PROVIDER_SETTINGS,
	}),
	provider_key_unreadable: () => ({
		cause: "The saved API key can't be decrypted, usually because APP_ENCRYPTION_KEY changed.",
		fix: "Enter the provider's API key again in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	provider_rejected: ({ provider, status }) => ({
		cause: `${provider} refused the request${http(status)}: a setting it does not accept, such as the model name or the base URL.`,
		fix: "Check the base URL and the model names of the provider in Admin → Agent, then use Test connection.",
		link: PROVIDER_SETTINGS,
	}),
	model_unavailable: ({ provider }) => ({
		cause: `The model is not available at ${provider}: it was renamed, retired or your account has no access to it.`,
		fix: "Pick a model the provider lists for your account in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	context_too_long: () => ({
		cause: "Some emails or conversations were longer than the model can read at once.",
		fix: "Pick a model with a larger context window in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	timeout: () => ({
		cause: "The model took longer than Kite waits for an answer, often a slow or overloaded model.",
		fix: "If it keeps happening, pick a faster model in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	cut_off: () => ({
		cause: "The model stopped before its answer was finished, usually a model that writes long or reasons at length.",
		fix: "Pick another model, or a lower reasoning effort, in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	unusable_answer: () => ({
		cause: "The model answered, but not in the format Kite asked for. Small models do this more often.",
		fix: "Pick a stronger model in Admin → Agent; Kite already retries these.",
		link: PROVIDER_SETTINGS,
	}),
	provider_unavailable: ({ provider, status }) => ({
		cause: `${provider} had a problem on its side${http(status)}. This is usually temporary.`,
		fix: `Check ${provider}'s status page. If it lasts, switch to another saved provider in Admin → Agent.`,
		link: PROVIDER_SETTINGS,
	}),
	provider_error: ({ provider }) => ({
		cause: `${provider} returned an error without saying why. This is usually temporary.`,
		fix: "Wait and see if it stops. If it lasts, use Test connection in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	provider_rate_limited: ({ provider, status }) => ({
		cause: `${provider} limited how many requests Kite may send${http(status ?? 429)}, or the account ran out of quota.`,
		fix: `Raise the limits or add credit at ${provider}, or lower the volume: see which features use the most in AI usage.`,
		link: USAGE,
	}),
	network: ({ provider }) => ({
		cause: `Kite could not reach ${provider}: a network problem, a wrong base URL or the provider being down.`,
		fix: "Check the base URL in Admin → Agent and use Test connection.",
		link: PROVIDER_SETTINGS,
	}),
	spend_cap: () => ({
		cause: "The daily AI spend cap was reached. It resets at 00:00 UTC.",
		fix: "Raise the daily spend cap in Admin → Agent if the spending is expected.",
		link: READING_SETTINGS,
	}),
	rate_limited: () => ({
		cause: "Kite's own limit on AI requests at once was reached.",
		fix: "Wait a moment; see AI usage for what sends the most requests.",
		link: USAGE,
	}),
	external_provider_not_allowed: () => ({
		cause: "The external AI provider is not allowed to read mail.",
		fix: "Allow it under automatic reading in Admin → Agent, or switch to Cloudflare Workers AI.",
		link: READING_SETTINGS,
	}),
	assistant_off: () => ({
		cause: "The assistant is turned off for everyone.",
		fix: "Turn on Enable assistant in Admin → Agent.",
		link: { href: "/agent", label: "Open Admin → Agent" },
	}),
	no_provider: () => ({
		cause: "No AI provider is set up.",
		fix: "Add a provider in Admin → Agent.",
		link: PROVIDER_SETTINGS,
	}),
	internal: () => ({
		cause: "Something went wrong inside Kite, not at the provider.",
		fix: "Look for ai.failed in the server logs around the times shown. Recent AI errors lists each request.",
		link: RECENT_ERRORS,
	}),
};

/** The cause, fix and link of one code, naming the provider when the failures came from one. */
export function explainAiFailure(code: AiErrorCode, input: Partial<ExplainInput> = {}): Explanation {
	return EXPLANATIONS[code]({ provider: input.provider || "The AI provider", status: input.status ?? null });
}

function tally<K>(items: K[], key: (item: K) => string): { item: K; count: number }[] {
	const counts = new Map<string, { item: K; count: number }>();
	for (const item of items) {
		const entry = counts.get(key(item));
		if (entry) entry.count += 1;
		else counts.set(key(item), { item, count: 1 });
	}
	// Map keeps insertion order, so equal counts stay newest first.
	return [...counts.values()].sort((a, b) => b.count - a.count);
}

/**
 * The failures grouped by code, the most frequent first (ties: the newest first). `rows` may come in any order;
 * each group's newest row gives the sentence and the provider its explanation names.
 */
export function groupAiFailures(rows: AiFailureRow[]): AiFailureGroup[] {
	const newestFirst = [...rows].sort((a, b) => b.at.localeCompare(a.at));
	const byCode = new Map<AiErrorCode, AiFailureRow[]>();
	for (const row of newestFirst) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row]);
	const groups = [...byCode.entries()].map(([code, items]): AiFailureGroup => {
		const latest = items[0];
		const models = tally(items, (row) => `${row.provider ?? ""}\u0000${row.model ?? ""}`).map(({ item, count }) => ({
			provider: item.provider,
			providerLabel: aiProviderLabel(item.provider),
			model: item.model,
			count,
		}));
		const features = tally(items, (row) => row.feature).map(({ item, count }) => ({
			feature: item.feature,
			label: AI_FEATURE_LABELS[item.feature],
			count,
		}));
		const statuses = [...new Set(items.flatMap((row) => (row.status ? [row.status] : [])))].sort((a, b) => a - b);
		// The provider most of the failures came from, so "OpenAI refused the key" names the right one.
		const provider = models.find((entry) => entry.providerLabel)?.providerLabel ?? undefined;
		return {
			code,
			count: items.length,
			firstAt: items[items.length - 1].at,
			lastAt: latest.at,
			features,
			models,
			statuses,
			latestMessage: aiErrorMessage(code, { status: latest.status }),
			...explainAiFailure(code, { provider, status: latest.status }),
		};
	});
	return groups.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

/** Failures that mean the assistant's own provider or model cannot answer either. */
const BLOCKING_CODES = new Set<AiErrorCode>(["provider_auth", "provider_key_unreadable", "no_provider"]);

/**
 * The newest failure that says the assistant's provider (or its default model) is broken right now, or null. Ask
 * AI would only fail the same way; a request that worked since (`okSince`) clears it.
 */
export function blockingAiFailure(
	rows: AiFailureRow[],
	current: { provider: string; model: string },
): AiFailureRow | null {
	const mine = rows
		.filter((row) => row.provider === current.provider)
		.sort((a, b) => b.at.localeCompare(a.at))
		.find((row) => BLOCKING_CODES.has(row.code) || (row.code === "model_unavailable" && row.model === current.model));
	return mine ?? null;
}

export type AskAiInput = {
	enabled: boolean;
	configured: boolean;
	keyUnreadable: boolean;
	/** The assistant uses an external provider and the primary admin has not allowed it to read mail. */
	externalNotAllowed: boolean;
	/** The newest blocking failure with no successful request since, from `blockingAiFailure`. */
	blocking: AiFailureRow | null;
	providerLabel: string;
};

/** Whether Ask AI can run, checked like the assistant's own path, and the reason and fix when it cannot. */
export function askAiState(input: AskAiInput): AskAiState {
	const refused = (code: AiErrorCode, prefix: string): AskAiState => {
		const { fix, link } = explainAiFailure(code, { provider: input.providerLabel });
		return { available: false, reason: `${prefix} ${fix}`, link };
	};
	if (!input.enabled) return refused("assistant_off", "Ask AI needs the assistant, which is turned off.");
	if (input.keyUnreadable)
		return refused("provider_key_unreadable", "Ask AI can't run: the saved API key can't be decrypted.");
	if (!input.configured) return refused("no_provider", "Ask AI needs an AI provider, and none is set up.");
	if (input.externalNotAllowed)
		return refused(
			"external_provider_not_allowed",
			`Ask AI can't run: ${input.providerLabel} is not allowed to read mail.`,
		);
	if (input.blocking)
		return refused(
			input.blocking.code,
			`Ask AI would fail the same way: the assistant uses ${input.providerLabel}, which is failing (${input.blocking.code}).`,
		);
	return { available: true };
}

const MAX_PROMPT_GROUPS = 8;
/** The chat route accepts 4,000 characters; the summary stays well under it. */
const MAX_PROMPT_CHARS = 3_500;

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * What Ask AI asks the assistant: counts, codes, features, providers, models, statuses and Kite's own sentences.
 * Never a person, a mailbox, a prompt, an answer or any mail.
 */
export function aiFailurePrompt(groups: AiFailureGroup[], total: number, capped: boolean): string {
	const lines = [
		`Kite recorded ${capped ? `at least ${total}` : total} failed AI ${total === 1 ? "request" : "requests"} in the last 24 hours. Explain the likely causes and what I should change to fix them. This summary has error codes and counts only, no email content.`,
	];
	groups.slice(0, MAX_PROMPT_GROUPS).forEach((group, index) => {
		const models = group.models
			.map(
				(entry) =>
					`${[entry.providerLabel, entry.model].filter(Boolean).join(" · ") || "no model chosen"} (${entry.count})`,
			)
			.join(", ");
		lines.push(
			"",
			`${index + 1}. ${group.code}: ${group.count} ${group.count === 1 ? "time" : "times"}, ${utc(group.firstAt)} to ${utc(group.lastAt)}`,
			`   Features: ${group.features.map((entry) => `${entry.label} (${entry.count})`).join(", ")}`,
			`   Provider and model: ${models}`,
			...(group.statuses.length ? [`   HTTP status: ${group.statuses.join(", ")}`] : []),
			`   Kite says: ${group.latestMessage}`,
		);
	});
	if (groups.length > MAX_PROMPT_GROUPS)
		lines.push("", `And ${groups.length - MAX_PROMPT_GROUPS} more kinds of failure.`);
	const text = lines.join("\n");
	return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS - 1)}…` : text;
}
