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
	return (await response.json()) as AdminAgentState;
}

function isLoopbackUrl(url: string): boolean {
	try {
		return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * The provider body that saves `state` again, or null when the API cannot recreate it. The API never returns
 * a saved key, so a compatible provider is restorable only when its key is known: passed in, or the fake key
 * for a loopback provider, which only these helpers configure.
 */
function restorableProvider(state: AdminAgentState, previousApiKey?: string): Record<string, unknown> | null {
	const { config } = state;
	const model = config.models.join(", ");
	if (config.provider === "cloudflare")
		return state.cloudflareAvailable
			? { provider: "cloudflare", preset: "openai", baseUrl: "", model, rates: config.rates }
			: null;
	const apiKey = previousApiKey ?? (isLoopbackUrl(config.baseUrl) ? FAKE_API_KEY : undefined);
	if (!config.hasApiKey || !apiKey) return null;
	return { provider: "compatible", preset: config.preset, baseUrl: config.baseUrl, apiKey, model, rates: config.rates };
}

async function putAdminAgent(api: APIRequestContext, data: Record<string, unknown>) {
	const response = await api.put("/api/admin/agent", { data });
	expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Points the install's assistant at the fake model, with automatic reading on and allowed to use it, and
 * returns a function that saves the previous provider, automatic reading settings and master switch again.
 * It throws before changing anything when the previous provider cannot be recreated through the API (a
 * compatible provider with an unknown key, or Cloudflare without the binding); pass `previousApiKey` for a
 * compatible provider whose key the caller knows.
 */
export async function useFakeProvider(
	api: APIRequestContext,
	fake: FakeModel,
	options: { previousApiKey?: string } = {},
): Promise<() => Promise<void>> {
	const previous = await readAdminAgent(api);
	const provider = restorableProvider(previous, options.previousApiKey);
	if (!provider)
		throw new Error(
			`useFakeProvider cannot restore the current ${previous.config.provider} provider; pass previousApiKey or start from a restorable one`,
		);
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
