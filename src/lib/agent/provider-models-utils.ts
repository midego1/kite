import type { AgentModelOption, AgentModelRates, AgentProviderPreset } from "./provider-types";

export function compatibleModelsRequest(preset: AgentProviderPreset, baseUrl: string, apiKey: string) {
	const anthropic = preset === "anthropic";
	const headers: Record<string, string> = anthropic
		? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" }
		: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
	return {
		url: `${baseUrl}/models${anthropic ? "?limit=1000" : ""}`,
		headers,
	};
}

export function perMillion(value: unknown, perToken: boolean): number | null {
	const price = typeof value === "string" ? Number(value) : value;
	if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
	return Number((perToken ? price * 1_000_000 : price).toPrecision(10));
}

function openRouterRates(pricing: unknown): AgentModelRates | undefined {
	if (!pricing || typeof pricing !== "object") return undefined;
	const input = perMillion((pricing as { prompt?: unknown }).prompt, true);
	const output = perMillion((pricing as { completion?: unknown }).completion, true);
	return input === null || output === null ? undefined : { input, output };
}

export function parseCompatibleAgentModelOptions(data: unknown, preset: AgentProviderPreset): AgentModelOption[] {
	if (!Array.isArray(data)) return [];
	return data
		.filter((item) => item && typeof item === "object" && typeof item.id === "string" && item.id.length <= 200)
		.map((item) => ({
			id: item.id as string,
			name:
				typeof item.name === "string"
					? item.name
					: typeof item.display_name === "string"
						? item.display_name
						: (item.id as string),
			rates: preset === "openrouter" ? openRouterRates(item.pricing) : undefined,
		}))
		.slice(0, 2_000)
		.sort((a, b) => a.name.localeCompare(b.name));
}
