import type { AgentModelOption, AgentModelRates, AgentProviderPreset } from "./provider-types";
import { getTargetAgentProviderConfig, resolveAgentBaseUrl } from "./provider";
import { compatibleModelsRequest, parseCompatibleAgentModelOptions, perMillion } from "./provider-models-utils";

export const CLOUDFLARE_TOOL_MODELS: AgentModelOption[] = [
	{ id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5" },
	{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
	{ id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B" },
];

// Workers AI lists prices as [{ unit: "per M input tokens", price, currency: "USD" }, ...] under properties.
function cloudflareRates(properties: unknown): AgentModelRates | undefined {
	if (!Array.isArray(properties)) return undefined;
	const entry = properties.find((item) => item && typeof item === "object" && item.property_id === "price");
	const prices: { unit?: unknown; price?: unknown; currency?: unknown }[] = Array.isArray(entry?.value)
		? entry.value
		: [];
	const find = (kind: "input" | "output") =>
		prices.find(
			(item) =>
				item?.currency === "USD" && /per m/i.test(String(item.unit)) && String(item.unit).toLowerCase().includes(kind),
		);
	const input = perMillion(find("input")?.price, false);
	const output = perMillion(find("output")?.price, false);
	return input === null || output === null ? undefined : { input, output };
}

export async function listCloudflareAgentModels(
	env: CloudflareEnv,
): Promise<{ models: AgentModelOption[]; source: "catalog" | "suggested" }> {
	if (!env.CF_ACCOUNT_ID || !env.CF_TOKEN) return { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" };
	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/ai/models/search?task=Text%20Generation`,
			{ headers: { Authorization: `Bearer ${env.CF_TOKEN}` }, signal: AbortSignal.timeout(10_000), redirect: "manual" },
		);
		if (!response.ok) throw new Error("Catalog unavailable");
		const json = (await response.json()) as {
			result?: { name?: unknown; description?: unknown; task?: unknown; properties?: unknown }[];
		};
		const models = (json.result ?? [])
			.filter(
				(item) =>
					typeof item.name === "string" &&
					item.name.startsWith("@cf/") &&
					(item.task === "Text Generation" || item.task === "text-generation" || !item.task),
			)
			.map((item) => ({ id: item.name as string, name: item.name as string, rates: cloudflareRates(item.properties) }))
			.slice(0, 200);
		return models.length ? { models, source: "catalog" } : { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" };
	} catch {
		return { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" };
	}
}

export async function listCompatibleAgentModels(
	env: CloudflareEnv,
	input: { preset: AgentProviderPreset; baseUrl: string; apiKey?: string; providerId?: string | null },
) {
	const baseUrl = resolveAgentBaseUrl(input.preset, input.baseUrl, env);
	// A blank key stands for the saved key of `providerId`, of the provider in use when omitted, none when null.
	const target =
		input.providerId === undefined ? "active" : input.providerId === null ? "new" : { id: input.providerId };
	const saved = input.apiKey?.trim() ? null : await getTargetAgentProviderConfig(env, target);
	const key =
		input.apiKey?.trim() ||
		(saved?.provider === "compatible" && saved.preset === input.preset && saved.baseUrl === baseUrl
			? saved.apiKey
			: "");
	if (!key) throw new Error("Enter an API key to load models");
	const request = compatibleModelsRequest(input.preset, baseUrl, key);
	const response = await fetch(request.url, {
		headers: request.headers,
		signal: AbortSignal.timeout(10_000),
		redirect: "manual",
	});
	if (!response.ok) throw new Error(`Model list request failed (${response.status})`);
	const json = (await response.json()) as { data?: unknown };
	const models = parseCompatibleAgentModelOptions(json.data, input.preset);
	if (!models.length) throw new Error("Provider returned no models");
	return { models, source: "catalog" as const };
}
