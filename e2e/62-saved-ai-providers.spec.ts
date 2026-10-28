import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { FAKE_API_KEY, useFakeProvider } from "./support/agent";
import { collectConsoleErrors } from "./support/auto-read";
import { chatRequests, firstMailboxId, sendChat } from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

/**
 * Saved AI providers in Admin → Agent: a second provider is saved with its own key, switched to with one click,
 * every chat request then goes to it with its key, and switching back needs no retyping. No response ever carries
 * a key.
 */

type SavedProvider = { id: string; name: string; active: boolean; models: string[]; hasApiKey: boolean };
type AdminAgent = { providers: SavedProvider[]; providersReady: boolean; config: { baseUrl: string } };

let api: APIRequestContext;
let fakeA: FakeModel;
let fakeB: FakeModel;
let restore: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	[fakeA, fakeB] = await Promise.all([startFakeModel(), startFakeModel()]);
	restore = await useFakeProvider(api, fakeA);
});

test.afterAll(async () => {
	await restore?.();
	await Promise.all([fakeA?.close(), fakeB?.close()]);
	await api?.dispose();
});

async function adminAgent(): Promise<AdminAgent> {
	const response = await api.get("/api/admin/agent");
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json()) as AdminAgent;
}

async function mailboxModel(mailboxId: string) {
	const response = await api.get(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`);
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json()) as {
		settings: { modelId: string | null };
		models: string[];
		unavailableModels: { chat: { saved: string; using: string | null } | null };
	};
}

async function putMailboxModel(mailboxId: string, modelId: string | null) {
	const response = await api.put("/api/agent/settings", { data: { mailboxId, modelId } });
	expect(response.ok(), await response.text()).toBe(true);
}

/** Every `/api/` response body the page receives, to prove no key ever leaves the server. */
function recordApiBodies(page: Page): string[] {
	const bodies: string[] = [];
	page.on("response", (response) => {
		if (!new URL(response.url()).pathname.startsWith("/api/")) return;
		void response
			.text()
			.then((text) => bodies.push(text))
			.catch(() => undefined);
	});
	return bodies;
}

test("save a second provider, switch to it in one click, chat uses it, and switch back without retyping", async ({
	page,
}) => {
	const keyB = `fake-b-key-${uniqueToken()}`;
	const nameB = `Fake B ${uniqueToken()}`;
	const bodies = recordApiBodies(page);
	const errors = collectConsoleErrors(page);
	const before = await adminAgent();
	expect(before.providersReady).toBe(true);
	const original = before.providers.find((provider) => provider.active);
	expect(original, "useFakeProvider saved the provider in use").toBeTruthy();
	const mailboxId = await firstMailboxId(api);
	const previousModel = (await mailboxModel(mailboxId)).settings.modelId;
	let savedB: SavedProvider | undefined;
	try {
		// A mailbox chooses fake-triage, which provider B will not offer.
		await putMailboxModel(mailboxId, "fake-triage");

		await page.goto("/agent");
		const rows = page.getByTestId("saved-provider");
		await expect(rows).toHaveCount(before.providers.length);
		await expect(rows.filter({ hasText: original!.name })).toContainText("In use");
		await page.getByRole("button", { name: "Add provider" }).click();
		await expect(page.getByRole("heading", { name: "New provider" })).toBeVisible();
		await page.getByLabel("Name", { exact: true }).fill(nameB);
		await chooseOption(page.getByLabel("Provider", { exact: true }), "custom");
		await page.getByLabel("API base URL").fill(fakeB.url);
		await page.getByLabel("API key").fill(keyB);
		// The catalog loads with the typed key from provider B, not from the provider in use.
		await expect(page.getByRole("checkbox", { name: "fake-draft" })).toBeVisible();
		await expect.poll(() => fakeB.requests().filter((request) => request.path === "/models").length).toBe(1);
		expect(fakeB.requests().find((request) => request.path === "/models")?.authorization).toBe(`Bearer ${keyB}`);
		await page.getByLabel("Or enter model IDs (comma-separated)").fill("fake-draft");
		await page.getByRole("button", { name: "Save provider" }).click();
		await expect(page.getByRole("status").filter({ hasText: "Provider added." })).toBeVisible();
		await expect(rows).toHaveCount(before.providers.length + 1);
		const rowB = rows.filter({ hasText: nameB });
		await expect(rowB).not.toContainText("In use");

		savedB = (await adminAgent()).providers.find((provider) => provider.name === nameB);
		expect(savedB).toMatchObject({ active: false, hasApiKey: true, models: ["fake-draft"] });
		const chatA = chatRequests(fakeA).length;
		fakeA.scriptChat({ content: "Answer from provider A." });
		expect((await sendChat(api, mailboxId, "Who answers?")).some((event) => event.type === "error")).toBe(false);
		expect(chatRequests(fakeA)).toHaveLength(chatA + 1);
		expect(chatRequests(fakeB)).toHaveLength(0);

		// One click switches every AI feature to provider B.
		await rowB.getByRole("button", { name: `Use ${nameB}` }).click();
		await expect(page.getByRole("status").filter({ hasText: `Now using ${nameB}.` })).toBeVisible();
		await expect(rowB).toContainText("In use");
		await expect(page.getByRole("button", { name: `Delete ${nameB}` })).toBeDisabled();
		const refused = await api.delete(`/api/admin/agent/providers/${savedB!.id}`);
		expect(refused.status()).toBe(409);
		expect(((await refused.json()) as { code: string }).code).toBe("ACTIVE_PROVIDER");

		// The mailbox's fake-triage is not offered by B: the default is used and the settings say so.
		const fallback = await mailboxModel(mailboxId);
		expect(fallback.models).toEqual(["fake-draft"]);
		expect(fallback.settings.modelId).toBe("fake-draft");
		expect(fallback.unavailableModels.chat).toEqual({ saved: "fake-triage", using: "fake-draft" });

		fakeB.scriptChat({ content: "Answer from provider B." });
		const eventsB = await sendChat(api, mailboxId, "Who answers now?");
		expect(eventsB.some((event) => event.type === "error")).toBe(false);
		expect(eventsB.map((event) => event.text ?? "").join("")).toContain("Answer from provider B.");
		const [requestB] = chatRequests(fakeB);
		expect(requestB.authorization).toBe(`Bearer ${keyB}`);
		expect((requestB.body as { model?: string }).model).toBe("fake-draft");
		expect(chatRequests(fakeA)).toHaveLength(chatA + 1);

		// Back to A: its key and models were kept.
		await rows
			.filter({ hasText: original!.name })
			.getByRole("button", { name: `Use ${original!.name}` })
			.click();
		await expect(page.getByRole("status").filter({ hasText: `Now using ${original!.name}.` })).toBeVisible();
		fakeA.scriptChat({ content: "Provider A again." });
		expect((await sendChat(api, mailboxId, "And now?")).some((event) => event.type === "error")).toBe(false);
		expect(chatRequests(fakeA)).toHaveLength(chatA + 2);
		expect(chatRequests(fakeA).at(-1)?.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
		expect((await mailboxModel(mailboxId)).unavailableModels.chat).toBeNull();

		const activity = (await (await api.get("/api/activity")).json()) as {
			activities: { action: string; metadata: string | null }[];
		};
		const switches = activity.activities.filter((row) => row.action === "agent.provider_switched");
		expect(switches.some((row) => JSON.parse(row.metadata ?? "{}").name === nameB)).toBe(true);

		await page.getByRole("button", { name: `Delete ${nameB}` }).click();
		await page.getByRole("button", { name: "Delete provider" }).click();
		await expect(rows).toHaveCount(before.providers.length);
		savedB = undefined;

		const everything = [...bodies, JSON.stringify(await adminAgent())].join("\n");
		expect(bodies.length).toBeGreaterThan(5);
		expect(everything).not.toContain(keyB);
		expect(everything).not.toContain(FAKE_API_KEY);
		expect(errors).toEqual([]);
	} finally {
		if (savedB) {
			await api.post(`/api/admin/agent/providers/${original!.id}/activate`);
			await api.delete(`/api/admin/agent/providers/${savedB.id}`);
		}
		await putMailboxModel(mailboxId, previousModel);
	}
});

test("only the primary admin reaches saved providers, and unknown ids answer 404", async () => {
	const missing = "aip_missing";
	expect((await api.post(`/api/admin/agent/providers/${missing}/activate`)).status()).toBe(404);
	expect((await api.delete(`/api/admin/agent/providers/${missing}`)).status()).toBe(404);
	const anonymous = await apiContext();
	try {
		expect((await anonymous.post("/api/admin/agent/providers", { data: {} })).status()).toBe(401);
	} finally {
		await anonymous.dispose();
	}
});
