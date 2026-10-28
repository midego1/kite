import type { LanguageModelUsage } from "ai";
import type { AgentModelRates } from "./provider-types";
import { ratesForPrompt } from "./auto-read/spend-utils";
import { parseAgentReasoningEffort } from "./reasoning-effort-utils";

export function parseAgentModelRates(value: string | null): Record<string, AgentModelRates> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).flatMap(([model, rates]) => {
				if (!rates || typeof rates !== "object" || Array.isArray(rates)) return [];
				const input = "input" in rates ? rates.input : null;
				const output = "output" in rates ? rates.output : null;
				const reasoningEffort = parseAgentReasoningEffort(
					"reasoningEffort" in rates ? rates.reasoningEffort : undefined,
				);
				return [
					[
						model,
						{
							input: typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null,
							output: typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : null,
							...(reasoningEffort ? { reasoningEffort } : {}),
						},
					],
				];
			}),
		);
	} catch {
		return {};
	}
}

export function calculateAgentCostUsdMicros(
	usage: LanguageModelUsage,
	rates: AgentModelRates | undefined,
): number | null {
	if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
	const priced = ratesForPrompt(rates, usage.inputTokens);
	if (!priced) return null;
	return Math.round(usage.inputTokens * priced.input + usage.outputTokens * priced.output);
}
