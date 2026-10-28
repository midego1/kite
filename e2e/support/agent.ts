import { expect, type APIRequestContext } from "@playwright/test";
import type { FakeModel } from "./fake-model-types";

type AdminAgentState = {
	config: {
		provider: "cloudflare" | "compatible";
		preset: string;
		baseUrl: string;
		models: string[];
		rates: Record<string, { input: number | null; output: number | null; reasoningEffort?: string }>;
		source: "saved" | "environment" | "default";
		hasApiKey: boolean;
		configured: boolean;
	};
	assistantEnabled: boolean;
	cloudflareAvailable: boolean;
	autoReadEnabled: boolean;
	externalAutoReadAllowed: boolean;
	dailySpendCapMicros: number;
};

export const FAKE_API_KEY = "fake-model-key";

export function fakeProviderSettings(fake: FakeModel) {
	return {
		provider: "compatible",
		preset: "custom",
		baseUrl: fake.url,
		apiKey: FAKE_API_KEY,
		model: "fake-triage, fake-draft",
		rates: { "fake-triage": { input: 0.05, output: 0.3 }, "fake-draft": { input: 0.05, output: 0.3 } },
	};
}

export async function readAdminAgent(api: APIRequestContext): Promise<AdminAgentState> {
	const response = await api.get("/api/admin/agent");
	expect(response.ok(), await response.text()).toBe(true);
	// Today's spend moves with every model call in parallel tests, so state comparisons leave it out.
	const { spentTodayMicros: _spentToday, ...state } = (await response.json()) as AdminAgentState & {
		spentTodayMicros?: number;
	};
	return state;
}

/**
 * The provider body that saves `state` again, or null when the API cannot recreate it. The API only reports
 * whether a key is saved, never the key itself, so a compatible provider is restorable only when the caller
 * passes its key. Nothing is inferred from the base URL: a loopback provider may hold any key.
 */
function restorableProvider(state: AdminAgentState, previousApiKey?: string): Record<string, unknown> | null {
	const { config } = state;
	const model = config.models.join(", ");
	if (config.provider === "cloudflare")
		return state.cloudflareAvailable
			? { provider: "cloudflare", preset: "openai", baseUrl: "", model, rates: config.rates }
			: null;
	if (!config.hasApiKey || !previousApiKey) return null;
	return {
		provider: "compatible",
		preset: config.preset,
		baseUrl: config.baseUrl,
		apiKey: previousApiKey,
		model,
		rates: config.rates,
	};
}

async function putAdminAgent(api: APIRequestContext, data: Record<string, unknown>) {
	const response = await api.put("/api/admin/agent", { data });
	expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Points the install's assistant at the fake model, with automatic reading on and allowed to use it, and
 * returns a function that saves the previous provider, automatic reading settings and master switch again.
 * It throws before changing anything when the previous provider cannot be recreated through the API (a
 * compatible provider without `previousApiKey`, or Cloudflare without the binding); pass `previousApiKey`
 * whenever the current provider is compatible, including one that points at a loopback fake model.
 */
export async function useFakeProvider(
	api: APIRequestContext,
	fake: FakeModel,
	options: { previousApiKey?: string } = {},
): Promise<() => Promise<void>> {
	const previous = await readAdminAgent(api);
	const provider = restorableProvider(previous, options.previousApiKey);
	if (!provider) {
		const reason =
			previous.config.provider === "cloudflare"
				? "the Cloudflare binding is unavailable"
				: `the key saved for ${previous.config.baseUrl || previous.config.preset} is unknown; pass previousApiKey`;
		throw new Error(`useFakeProvider cannot restore the current ${previous.config.provider} provider: ${reason}`);
	}
	await putAdminAgent(api, { enabled: true });
	await putAdminAgent(api, fakeProviderSettings(fake));
	await putAdminAgent(api, { autoReadEnabled: true, externalAutoReadAllowed: true });
	return async () => {
		await putAdminAgent(api, provider);
		await putAdminAgent(api, {
			autoReadEnabled: previous.autoReadEnabled,
			externalAutoReadAllowed: previous.externalAutoReadAllowed,
			dailySpendCapMicros: previous.dailySpendCapMicros,
		});
		await putAdminAgent(api, { enabled: previous.assistantEnabled });
	};
}
