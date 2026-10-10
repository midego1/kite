import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DRAFT_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers";
import { BASE_URL, DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { FAKE_API_KEY, fakeProviderSettings, readAdminAgent, useFakeProvider } from "./support/agent";
import {
	autoReadFields,
	collectConsoleErrors,
	createSharedMailbox,
	createSignedInAccount,
	okJson,
	openAutoReadSection,
	readMailboxSettings,
	selectMailbox,
	shareMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { QUESTION_DRAFT_BODY } from "./support/fake-model-scenarios";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, deliverInbound, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { readJobs, waitForFinishedJob } from "./support/triage";

let fake: FakeModel;
let api: APIRequestContext;

test.beforeAll(async () => {
	fake = await startFakeModel();
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
	await fake.close();
});

test.beforeEach(() => {
	fake.clearRequests();
	fake.resetDefaultScenario();
});

test.describe("fake model provider", () => {
	test("the fake model answers scenarios in the OpenAI shape and records requests", async () => {
		const response = await fetch(`${fake.url}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "fake-draft",
				messages: [
					{ role: "system", content: `${DRAFT_SYSTEM_MARKER} Write a reply.` },
					{ role: "user", content: "Can you confirm? [[scenario:question]]" },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			choices: { message: { content: string }; finish_reason: string }[];
			usage: { total_tokens: number };
		};
		expect(body.choices[0]).toMatchObject({ message: { content: QUESTION_DRAFT_BODY }, finish_reason: "stop" });
		expect(body.usage.total_tokens).toBeGreaterThan(0);
		expect(fake.requests()).toEqual([expect.objectContaining({ kind: "draft", scenario: "question" })]);

		const control = (await (await fetch(`${fake.url}/__fake/requests`)).json()) as {
			requests: { body: { messages: unknown[] } }[];
		};
		expect(control.requests).toHaveLength(1);
		expect(control.requests[0].body.messages).toHaveLength(2);
		await fetch(`${fake.url}/__fake/requests`, { method: "DELETE" });
		expect(fake.requests()).toEqual([]);
	});

	test("the primary admin can point the assistant at the loopback fake model", async () => {
		const models = await api.post("/api/admin/agent/models", {
			data: { provider: "compatible", preset: "custom", baseUrl: fake.url, apiKey: FAKE_API_KEY },
		});
		expect(models.ok(), await models.text()).toBe(true);
		expect(((await models.json()) as { models: { id: string }[] }).models.map((model) => model.id)).toEqual([
			"fake-draft",
			"fake-triage",
		]);
		expect(fake.requests().map((request) => request.path)).toEqual(["/models"]);

		const restore = await useFakeProvider(api, fake);
		try {
			const state = await readAdminAgent(api);
			expect(state.assistantEnabled).toBe(true);
			expect(state.config).toMatchObject({
				provider: "compatible",
				preset: "custom",
				baseUrl: fake.url,
				models: ["fake-triage", "fake-draft"],
				configured: true,
			});
		} finally {
			await restore();
		}
	});

	test("plain http is refused for any host other than loopback", async () => {
		const response = await api.put("/api/admin/agent", {
			data: { ...fakeProviderSettings(fake), baseUrl: "http://example.com:3301" },
		});
		expect(response.status()).toBe(400);
	});
});

test("inbound mail can carry an .ics attachment and extra headers", async () => {
	const subject = uniqueToken("invite");
	const ics = [
		"BEGIN:VCALENDAR",
		"METHOD:REQUEST",
		"BEGIN:VEVENT",
		`UID:${subject}@partner.test`,
		"END:VEVENT",
		"END:VCALENDAR",
	];
	const message = await deliverInbound(api, {
		from: "Alice Partner <alice@partner.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "Please join us. [[scenario:invite-free]]",
		headers: { "List-Id": "<team.partner.test>", "List-Unsubscribe": "<https://partner.test/unsubscribe>" },
		attachments: [
			{
				filename: "invite.ics",
				contentType: "text/calendar; method=REQUEST; charset=utf-8",
				content: ics.join("\r\n"),
			},
		],
	});
	const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
		attachments: { filename: string; type: string }[];
	};
	expect(detail.attachments).toEqual([expect.objectContaining({ filename: "invite.ics", type: "text/calendar" })]);
	const original = await (await api.get(`/api/messages/${message.id}/original`)).text();
	expect(original).toContain("List-Id: <team.partner.test>");
	expect(original).toContain("multipart/mixed");
});

test.describe("automatic reading settings API", () => {
	test("a mailbox without settings gets the defaults, and calendar starts off on a shared mailbox", async () => {
		const token = uniqueToken("ard");
		const owner = await createSignedInAccount(api, `ard${token}`);
		try {
			const personal = await readMailboxSettings(owner.api, owner.mailboxId);
			expect(autoReadFields(personal)).toEqual({
				autonomy: "off",
				capabilities: { calendar: true, reply: true, summary: true, phishing: true, mutedSenders: [] },
				triageModelId: null,
				autoReadDailyLimit: 200,
				dailySpendCapMicros: null,
				pausedUntil: null,
			});
			expect(personal.canManage).toBe(true);
			expect(typeof personal.autoReadAvailable).toBe("boolean");
			expect(typeof personal.externalProviderBlocked).toBe("boolean");
			expect(typeof personal.providerLabel).toBe("string");
		} finally {
			await owner.api.dispose();
		}

		const sharedId = await createSharedMailbox(api, `ards${token}`);
		const shared = await readMailboxSettings(api, sharedId);
		expect(shared.settings.capabilities).toMatchObject({ calendar: false, reply: true, summary: true, phishing: true });
		await okJson(await api.put("/api/agent/settings", { data: { mailboxId: sharedId, dailyLimit: 25 } }));
		expect((await readMailboxSettings(api, sharedId)).settings.capabilities.calendar).toBe(false);
	});

	test("every automatic reading field is saved, and invalid or unavailable values are refused", async () => {
		const sharedId = await createSharedMailbox(api, `arp${uniqueToken("arp")}`);
		const restore = await useFakeProvider(api, fake);
		try {
			// The column stores whole seconds.
			const pausedUntil = new Date(Math.floor(Date.now() / 1000 + 24 * 60 * 60) * 1000).toISOString();
			await okJson(
				await api.put("/api/agent/settings", {
					data: {
						mailboxId: sharedId,
						autonomy: "suggest",
						capabilities: {
							calendar: true,
							reply: false,
							summary: true,
							phishing: false,
							mutedSenders: ["Spam@Outside.test"],
						},
						triageModelId: "fake-triage",
						autoReadDailyLimit: 42,
						dailySpendCapMicros: 1234,
						pausedUntil,
					},
				}),
			);
			const saved = await readMailboxSettings(api, sharedId);
			expect(autoReadFields(saved)).toEqual({
				autonomy: "suggest",
				capabilities: {
					calendar: true,
					reply: false,
					summary: true,
					phishing: false,
					mutedSenders: ["spam@outside.test"],
				},
				triageModelId: "fake-triage",
				autoReadDailyLimit: 42,
				dailySpendCapMicros: 1234,
				pausedUntil,
			});
			expect(saved).toMatchObject({
				autoReadAvailable: true,
				externalProviderBlocked: false,
				providerLabel: "127.0.0.1",
			});

			// The settings form saves the whole object it loaded, without the muted senders it never edits.
			const { capabilities, ...form } = saved.settings;
			await okJson(
				await api.put("/api/agent/settings", {
					data: { ...form, capabilities: { ...capabilities, mutedSenders: undefined, summary: false } },
				}),
			);
			const resaved = await readMailboxSettings(api, sharedId);
			expect(resaved.settings.capabilities).toMatchObject({ summary: false, mutedSenders: ["spam@outside.test"] });

			for (const data of [
				{ autonomy: "act" },
				{ autonomy: "auto" },
				{ autoReadDailyLimit: 0 },
				{ autoReadDailyLimit: 1001 },
				{ dailySpendCapMicros: -1 },
				{ triageModelId: "not-a-configured-model" },
				{ pausedUntil: "not-a-date" },
			]) {
				const response = await api.put("/api/agent/settings", { data: { mailboxId: sharedId, ...data } });
				expect(response.status(), JSON.stringify(data)).toBe(400);
				const { error } = (await response.json()) as { error: string };
				if (data.autonomy) expect(error).toContain("not available yet");
				else expect(error.length).toBeGreaterThan(0);
			}
			expect(autoReadFields(await readMailboxSettings(api, sharedId))).toEqual(autoReadFields(resaved));

			for (const data of [
				{ autoReadDailyLimit: 1 },
				{ autoReadDailyLimit: 1000 },
				{ dailySpendCapMicros: null },
				{ dailySpendCapMicros: 0 },
				{ pausedUntil: null, autonomy: "off" },
			])
				await okJson(await api.put("/api/agent/settings", { data: { mailboxId: sharedId, ...data } }));
			expect(autoReadFields(await readMailboxSettings(api, sharedId))).toMatchObject({
				autonomy: "off",
				autoReadDailyLimit: 1000,
				dailySpendCapMicros: 0,
				pausedUntil: null,
			});
		} finally {
			await restore();
		}
	});

	test("users without full access cannot change automatic reading", async () => {
		const token = uniqueToken("arr");
		const sharedId = await createSharedMailbox(api, `arr${token}`);
		const reader = await createSignedInAccount(api, `arrr${token}`);
		const sender = await createSignedInAccount(api, `arrs${token}`);
		const outsider = await createSignedInAccount(api, `arro${token}`);
		await shareMailbox(api, sharedId, reader.id, "read_only");
		await shareMailbox(api, sharedId, sender.id, "send_on_behalf");
		try {
			const before = autoReadFields(await readMailboxSettings(api, sharedId));
			expect((await readMailboxSettings(reader.api, sharedId)).canManage).toBe(false);
			for (const user of [reader, sender, outsider])
				for (const data of [
					{ autonomy: "suggest" },
					{ capabilities: { calendar: true } },
					{ pausedUntil: new Date(Date.now() + 60_000).toISOString() },
					{ autoReadDailyLimit: 5 },
				]) {
					const response = await user.api.put("/api/agent/settings", { data: { mailboxId: sharedId, ...data } });
					expect(response.status(), JSON.stringify(data)).toBe(403);
				}
			expect(autoReadFields(await readMailboxSettings(api, sharedId))).toEqual(before);
		} finally {
			await Promise.all([reader.api.dispose(), sender.api.dispose(), outsider.api.dispose()]);
		}
	});
});

test.describe("admin automatic reading settings", () => {
	test("only the primary admin changes them, values are validated and provider fields stay untouched", async () => {
		const token = uniqueToken("ara");
		const before = await readAdminAgent(api);
		expect(before).toMatchObject({
			autoReadEnabled: expect.any(Boolean),
			externalAutoReadAllowed: expect.any(Boolean),
			dailySpendCapMicros: expect.any(Number),
		});
		expect(Object.keys(before).some((key) => /fullauto/i.test(key))).toBe(false);

		const admin = await createSignedInAccount(api, `araa${token}`, "admin");
		const user = await createSignedInAccount(api, `arau${token}`);
		try {
			for (const client of [admin.api, user.api]) {
				for (const data of [{ autoReadEnabled: false }, { externalAutoReadAllowed: true }, { dailySpendCapMicros: 1 }])
					expect((await client.put("/api/admin/agent", { data })).status(), JSON.stringify(data)).toBe(403);
				expect((await client.get("/api/admin/agent")).status()).toBe(403);
			}
			for (const data of [{ dailySpendCapMicros: -5 }, { autoReadEnabled: "yes" }, { externalAutoReadAllowed: 1 }])
				expect((await api.put("/api/admin/agent", { data })).status(), JSON.stringify(data)).toBe(400);
			expect(await readAdminAgent(api)).toEqual(before);

			const changed = await okJson<typeof before>(
				await api.put("/api/admin/agent", {
					data: {
						autoReadEnabled: !before.autoReadEnabled,
						externalAutoReadAllowed: !before.externalAutoReadAllowed,
						dailySpendCapMicros: 1,
					},
				}),
			);
			expect(changed).toEqual({
				...before,
				autoReadEnabled: !before.autoReadEnabled,
				externalAutoReadAllowed: !before.externalAutoReadAllowed,
				dailySpendCapMicros: 1,
			});
		} finally {
			await api.put("/api/admin/agent", {
				data: {
					autoReadEnabled: before.autoReadEnabled,
					externalAutoReadAllowed: before.externalAutoReadAllowed,
					dailySpendCapMicros: before.dailySpendCapMicros,
				},
			});
			await Promise.all([admin.api.dispose(), user.api.dispose()]);
		}
		expect(await readAdminAgent(api)).toEqual(before);
	});

	test("useFakeProvider turns automatic reading on and restores the previous flags", async () => {
		const before = await readAdminAgent(api);
		const restore = await useFakeProvider(api, fake);
		try {
			expect(await readAdminAgent(api)).toMatchObject({ autoReadEnabled: true, externalAutoReadAllowed: true });
		} finally {
			await restore();
		}
		expect(await readAdminAgent(api)).toMatchObject({
			autoReadEnabled: before.autoReadEnabled,
			externalAutoReadAllowed: before.externalAutoReadAllowed,
		});
	});

	test("a reasoning effort can be saved per model, and none is refused", async () => {
		const restore = await useFakeProvider(api, fake);
		try {
			const settings = fakeProviderSettings(fake);
			const withEffort = {
				...settings,
				rates: { ...settings.rates, "fake-triage": { ...settings.rates["fake-triage"], reasoningEffort: "minimal" } },
			};
			await okJson(await api.put("/api/admin/agent", { data: withEffort }));
			const { config } = await readAdminAgent(api);
			expect(config.rates["fake-triage"]).toEqual({ input: 0.05, output: 0.3, reasoningEffort: "minimal" });
			expect(config.rates["fake-draft"]).toEqual({ input: 0.05, output: 0.3 });

			const none = {
				...settings,
				rates: { ...settings.rates, "fake-triage": { ...settings.rates["fake-triage"], reasoningEffort: "none" } },
			};
			expect((await api.put("/api/admin/agent", { data: none })).status()).toBe(400);
			expect((await readAdminAgent(api)).config.rates["fake-triage"].reasoningEffort).toBe("minimal");
			// The auto-read branch never touches provider fields.
			await okJson(await api.put("/api/admin/agent", { data: { dailySpendCapMicros: 2_000_000 } }));
			expect((await readAdminAgent(api)).config).toEqual(config);
		} finally {
			await restore();
		}
	});
});

const AUTO_READ_ADMIN_KEYS = ["autoReadEnabled", "externalAutoReadAllowed", "dailySpendCapMicros"];

function settingsPut(page: Page) {
	return page.waitForResponse(
		(response) => response.url().endsWith("/api/agent/settings") && response.request().method() === "PUT",
	);
}

test.describe("automatic reading settings UI", () => {
	test("the section saves every field, survives a reload, and pauses and resumes", async ({ page }) => {
		const errors = collectConsoleErrors(page);
		const sharedId = await createSharedMailbox(api, `aru${uniqueToken("aru")}`);
		const restore = await useFakeProvider(api, fake);
		try {
			await selectMailbox(page, sharedId);
			let section = await openAutoReadSection(page);
			await expect(section.getByRole("radio", { name: "Off" })).toBeChecked();
			await expect(section.getByRole("radio", { name: "Suggest only" })).toBeEnabled();
			for (const name of ["Act with undo", "Full auto"])
				await expect(section.getByRole("radio", { name })).toBeDisabled();
			await expect(section.getByText("Not available yet")).toHaveCount(2);
			await section.getByRole("radio", { name: "Full auto" }).click({ force: true });
			await expect(section.getByRole("radio", { name: "Off" })).toBeChecked();
			await expect(section.getByText("Message content is sent to 127.0.0.1.")).toBeVisible();
			await expect(section.getByText(/must allow the external provider/)).toHaveCount(0);
			await expect(section.getByRole("button", { name: "Pause for 24 hours" })).toBeDisabled();

			await section.getByRole("radio", { name: "Suggest only" }).check();
			await section.getByRole("switch", { name: "Summaries and tasks" }).click();
			await section.getByRole("combobox", { name: "Triage model" }).selectOption("fake-triage");
			await section.getByRole("spinbutton", { name: "Daily triage limit" }).fill("50");
			await section.getByRole("spinbutton", { name: /spend cap/ }).fill("0.50");
			const saved = settingsPut(page);
			await section.getByRole("button", { name: "Save automatic reading" }).click();
			const response = await saved;
			expect(response.status()).toBe(200);
			expect(response.request().postDataJSON()).toEqual({
				mailboxId: sharedId,
				autonomy: "suggest",
				capabilities: { calendar: false, reply: true, summary: false, phishing: true },
				triageModelId: "fake-triage",
				autoReadDailyLimit: 50,
				dailySpendCapMicros: 500_000,
			});

			await page.reload();
			section = await openAutoReadSection(page);
			await expect(section.getByRole("radio", { name: "Suggest only" })).toBeChecked();
			await expect(section.getByRole("switch", { name: "Summaries and tasks" })).toHaveAttribute(
				"aria-checked",
				"false",
			);
			await expect(section.getByRole("combobox", { name: "Triage model" })).toHaveValue("fake-triage");
			await expect(section.getByRole("spinbutton", { name: "Daily triage limit" })).toHaveValue("50");
			await expect(section.getByRole("spinbutton", { name: /spend cap/ })).toHaveValue("0.50");
			expect(autoReadFields(await readMailboxSettings(api, sharedId))).toMatchObject({
				autonomy: "suggest",
				capabilities: { summary: false },
				triageModelId: "fake-triage",
				autoReadDailyLimit: 50,
				dailySpendCapMicros: 500_000,
				pausedUntil: null,
			});

			const paused = settingsPut(page);
			await section.getByRole("button", { name: "Pause for 24 hours" }).click();
			expect((await paused).status()).toBe(200);
			await expect(section.getByText(/^Paused until/)).toBeVisible();
			const { settings } = await readMailboxSettings(api, sharedId);
			expect(settings.autonomy).toBe("suggest");
			expect(Math.abs(Date.parse(settings.pausedUntil!) - (Date.now() + 24 * 60 * 60 * 1000))).toBeLessThan(120_000);

			await page.reload();
			section = await openAutoReadSection(page);
			await expect(section.getByText(/^Paused until/)).toBeVisible();
			await expect(section.getByRole("radio", { name: "Suggest only" })).toBeChecked();
			const resumed = settingsPut(page);
			await section.getByRole("button", { name: "Resume" }).click();
			expect((await resumed).status()).toBe(200);
			await expect(section.getByRole("button", { name: "Pause for 24 hours" })).toBeEnabled();
			expect((await readMailboxSettings(api, sharedId)).settings.pausedUntil).toBeNull();
			await page.reload();
			section = await openAutoReadSection(page);
			await expect(section.getByRole("button", { name: "Pause for 24 hours" })).toBeVisible();
			expect(errors).toEqual([]);
		} finally {
			await restore();
		}
	});

	test("the legacy settings form no longer overwrites automatic reading values", async ({ page }) => {
		const sharedId = await createSharedMailbox(api, `arl${uniqueToken("arl")}`);
		const restore = await useFakeProvider(api, fake);
		try {
			await selectMailbox(page, sharedId);
			const section = await openAutoReadSection(page);
			await okJson(await api.put("/api/agent/settings", { data: { mailboxId: sharedId, autonomy: "suggest" } }));
			const saved = settingsPut(page);
			await page.locator("#email-assistant-panel").getByRole("button", { name: "Save settings" }).click();
			const body = (await saved).request().postDataJSON() as Record<string, unknown>;
			expect(Object.keys(body)).not.toContain("autonomy");
			expect(Object.keys(body)).not.toContain("capabilities");
			expect((await readMailboxSettings(api, sharedId)).settings.autonomy).toBe("suggest");
			await expect(section).toBeVisible();
		} finally {
			await restore();
		}
	});

	test("the section explains a blocked external provider and an admin turning automatic reading off", async ({
		page,
	}) => {
		const sharedId = await createSharedMailbox(api, `arx${uniqueToken("arx")}`);
		const restore = await useFakeProvider(api, fake);
		try {
			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
			expect((await readMailboxSettings(api, sharedId)).externalProviderBlocked).toBe(true);
			await selectMailbox(page, sharedId);
			let section = await openAutoReadSection(page);
			await expect(section.getByText(/primary admin must allow the external provider/)).toBeVisible();
			await expect(section.getByText(/admin has turned automatic reading off/)).toHaveCount(0);

			await okJson(
				await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: true, autoReadEnabled: false } }),
			);
			await page.reload();
			section = await openAutoReadSection(page);
			await expect(section.getByText(/admin has turned automatic reading off/)).toBeVisible();
			await expect(section.getByText(/primary admin must allow the external provider/)).toHaveCount(0);

			await okJson(await api.put("/api/admin/agent", { data: { autoReadEnabled: true } }));
			await page.reload();
			section = await openAutoReadSection(page);
			await expect(section.getByText(/admin has turned automatic reading off/)).toHaveCount(0);
			expect((await readMailboxSettings(api, sharedId)).externalProviderBlocked).toBe(false);
		} finally {
			await restore();
		}
	});

	test("a read-only sharer sees no editable automatic reading controls", async ({ browser }) => {
		const token = uniqueToken("aro");
		const sharedId = await createSharedMailbox(api, `aro${token}`);
		const reader = await createSignedInAccount(api, `aror${token}`);
		await shareMailbox(api, sharedId, reader.id, "read_only");
		const restore = await useFakeProvider(api, fake);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await reader.api.storageState() });
		try {
			expect((await readMailboxSettings(reader.api, sharedId)).canManage).toBe(false);
			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, sharedId);
			const section = await openAutoReadSection(page);
			await expect(section.getByText(/Full mailbox access is required/)).toBeVisible();
			for (const radio of await section.getByRole("radio").all()) await expect(radio).toBeDisabled();
			for (const toggle of await section.getByRole("switch").all()) await expect(toggle).toBeDisabled();
			await expect(section.getByRole("switch")).toHaveCount(4);
			await expect(section.getByRole("combobox", { name: "Triage model" })).toBeDisabled();
			for (const input of await section.getByRole("spinbutton").all()) await expect(input).toBeDisabled();
			await expect(section.getByRole("button")).toHaveCount(0);
			expect(errors).toEqual([]);
		} finally {
			await context.close();
			await reader.api.dispose();
			await restore();
		}
	});

	test("the admin page saves the kill switch, the external opt-in and the spend cap with auto-read keys only", async ({
		page,
	}) => {
		const errors = collectConsoleErrors(page);
		const restore = await useFakeProvider(api, fake);
		const before = await readAdminAgent(api);
		const bodies: Record<string, unknown>[] = [];
		page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().endsWith("/api/admin/agent"))
				bodies.push(request.postDataJSON() as Record<string, unknown>);
		});
		const adminPut = () =>
			page.waitForResponse(
				(response) => response.url().endsWith("/api/admin/agent") && response.request().method() === "PUT",
			);
		try {
			await page.goto("/agent");
			const killSwitch = page.getByRole("switch", { name: "Enable automatic reading" });
			const optIn = page.getByRole("switch", { name: "Allow external provider for automatic reading" });
			const cap = page.getByLabel("Daily spend cap for automatic reading (USD)");
			await expect(killSwitch).toHaveAttribute("aria-checked", "true");
			await expect(optIn).toHaveAttribute("aria-checked", "true");
			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
			await page.reload();
			await expect(optIn).toHaveAttribute("aria-checked", "false");
			await expect(cap).toHaveValue("2.00");

			let saved = adminPut();
			await killSwitch.click();
			expect((await saved).status()).toBe(200);
			await expect(killSwitch).toHaveAttribute("aria-checked", "false");
			saved = adminPut();
			await optIn.click();
			expect((await saved).status()).toBe(200);
			await expect(optIn).toHaveAttribute("aria-checked", "true");
			await cap.fill("1.00");
			saved = adminPut();
			await page.getByRole("button", { name: "Save spend cap" }).click();
			expect((await saved).status()).toBe(200);

			await page.reload();
			await expect(killSwitch).toHaveAttribute("aria-checked", "false");
			await expect(optIn).toHaveAttribute("aria-checked", "true");
			await expect(cap).toHaveValue("1.00");
			const after = await readAdminAgent(api);
			expect(after).toEqual({
				...before,
				autoReadEnabled: false,
				externalAutoReadAllowed: true,
				dailySpendCapMicros: 1_000_000,
			});
			expect(bodies).toHaveLength(3);
			for (const body of bodies)
				expect(
					Object.keys(body).every((key) => AUTO_READ_ADMIN_KEYS.includes(key)),
					JSON.stringify(body),
				).toBe(true);
			expect(errors).toEqual([]);
		} finally {
			await api.put("/api/admin/agent", { data: { dailySpendCapMicros: before.dailySpendCapMicros } });
			await restore();
		}
	});
});

test.describe("triage scheduling", () => {
	const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));
	const modelRequests = () => fake.requests().filter((request) => request.path.endsWith("/chat/completions"));

	async function suggestAccount(prefix: string) {
		const username = `${prefix}${uniqueToken("")}`;
		const account = await createSignedInAccount(api, username);
		return { ...account, address: `${username}@${DOMAIN}` };
	}

	async function setAutonomy(account: { api: APIRequestContext; mailboxId: string }, data: Record<string, unknown>) {
		await okJson(await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, ...data } }));
	}

	test("eligible mail gets exactly one triage job, even when it is delivered twice", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("trg");
		try {
			await setAutonomy(account, { autonomy: "suggest" });
			const subject = uniqueToken("triagetwice");
			const mail = {
				from: "Customer <customer@outside.test>",
				to: account.address,
				subject,
				text: "Could you confirm the order?",
				messageId: `<${subject}@outside.test>`,
			};
			const first = await deliverInbound(account.api, mail);
			const job = await waitForFinishedJob(account.api, account.mailboxId, first.id, "triage");
			expect(job.status).toBe("completed");

			await postInbound(account.api, mail);
			await expect
				.poll(async () => {
					const response = await account.api.get(`/api/messages?q=${subject}&limit=20`);
					return ((await response.json()) as { messages: unknown[] }).messages.length;
				})
				.toBe(2);
			await settle();
			const triage = (await readJobs(account.api, account.mailboxId)).filter((row) => row.kind === "triage");
			expect(triage).toEqual([expect.objectContaining({ id: job.id, sourceMessageId: first.id })]);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("bounces, the mailbox's own address and auto-submitted mail get no job", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("trn");
		try {
			await setAutonomy(account, { autonomy: "suggest" });
			const token = uniqueToken("ineligible");
			const senders = [account.address, "MAILER-DAEMON@relay.outside.test", "postmaster@relay.outside.test"];
			for (const [index, from] of senders.entries())
				await postInbound(account.api, { from, to: account.address, subject: `${token} ${index}`, text: "Hi" });
			await postInbound(account.api, {
				from: "Out Of Office <person@outside.test>",
				to: account.address,
				subject: `${token} auto`,
				text: "I am away.",
				headers: { "Auto-Submitted": "auto-replied" },
			});
			const barrier = await deliverInbound(account.api, {
				from: "Customer <customer@outside.test>",
				to: account.address,
				subject: `${token} barrier`,
				text: "A real question.",
			});
			await waitForFinishedJob(account.api, account.mailboxId, barrier.id, "triage");
			await waitForMessage(account.api, `${token} auto`);
			await settle();
			expect((await readJobs(account.api, account.mailboxId)).map((job) => job.sourceMessageId)).toEqual([barrier.id]);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("list, bulk and no-reply mail is triaged without a model request", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("trb");
		try {
			await setAutonomy(account, { autonomy: "suggest" });
			const token = uniqueToken("bulk");
			const mails: { from: string; subject: string; headers: Record<string, string> }[] = [
				{
					from: "Team List <team@lists.outside.test>",
					subject: `${token} list`,
					headers: { "List-Id": "<team.lists.outside.test>", "List-Unsubscribe": "<https://outside.test/u>" },
				},
				{ from: "News <news@outside.test>", subject: `${token} bulk`, headers: { Precedence: "bulk" } },
				{ from: "Vendor <no-reply@vendor.example>", subject: `${token} noreply`, headers: {} },
			];
			for (const mail of mails) {
				const stored = await deliverInbound(account.api, {
					...mail,
					to: account.address,
					text: "Weekly update [[scenario:question]]",
				});
				const job = await waitForFinishedJob(account.api, account.mailboxId, stored.id, "triage");
				expect(job.status).toBe("completed");
			}
			expect(modelRequests()).toEqual([]);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("autonomy off with auto-draft on keeps the legacy draft job and no triage", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("trl");
		try {
			await setAutonomy(account, { autonomy: "off", autoDraftEnabled: true });
			const subject = uniqueToken("legacy");
			// The draft can be listed before the inbound copy, so the job is found by kind rather than by message.
			await postInbound(account.api, {
				from: "Customer <customer@outside.test>",
				to: account.address,
				subject,
				text: "Can you confirm Tuesday? [[scenario:question]]",
			});
			await expect
				.poll(async () => (await readJobs(account.api, account.mailboxId)).map((row) => `${row.kind}:${row.status}`), {
					timeout: 30_000,
				})
				.toEqual(["draft:completed"]);
			const [job] = await readJobs(account.api, account.mailboxId);
			expect(job).toMatchObject({ status: "completed", draftId: expect.any(String) });
			expect((await readJobs(account.api, account.mailboxId)).map((row) => row.kind)).toEqual(["draft"]);
			const kinds = modelRequests().map((request) => request.kind);
			expect(kinds.length).toBeGreaterThan(0);
			expect(kinds.every((kind) => kind === "draft")).toBe(true);
			const drafts = await okJson<{ messages: { id: string }[] }>(
				await account.api.get("/api/messages?status=draft&limit=20"),
			);
			expect(drafts.messages.map((message) => message.id)).toContain(job.draftId);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});
});
