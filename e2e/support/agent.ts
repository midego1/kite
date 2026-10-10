import { expect, type APIRequestContext } from "@playwright/test";
import type { FakeModel } from "./fake-model-types";

type AdminAgentState = {
	config: {
		provider: "cloudflare" | "compatible";
		preset: string;
		baseUrl: string;
		models: string[];
		rates: Record<string, { input: number | null; output: number | null }>;
		source: "saved" | "environment" | "default";
	};
	assistantEnabled: boolean;
	cloudflareAvailable: boolean;
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

/**
 * Points the install's assistant at the fake model and returns a function that puts the previous
 * provider back. A provider that was never saved, or a compatible one whose key is unknown here,
 * cannot be restored through the API; the Cloudflare provider is saved instead when it is available.
 */
export async function useFakeProvider(api: APIRequestContext, fake: FakeModel): Promise<() => Promise<void>> {
	const previous = await readAdminAgent(api);
	const enabled = await api.put("/api/admin/agent", { data: { enabled: true } });
	expect(enabled.ok(), await enabled.text()).toBe(true);
	const saved = await api.put("/api/admin/agent", { data: fakeProviderSettings(fake) });
	expect(saved.ok(), await saved.text()).toBe(true);
	return async () => {
		if (previous.cloudflareAvailable && previous.config.provider === "cloudflare") {
			await api.put("/api/admin/agent", {
				data: {
					provider: "cloudflare",
					preset: "openai",
					baseUrl: "",
					model: previous.config.models.join(", "),
					rates: previous.config.rates,
				},
			});
		}
		await api.put("/api/admin/agent", { data: { enabled: previous.assistantEnabled } });
	};
}
