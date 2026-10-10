import { expect, test, type APIRequestContext } from "@playwright/test";
import { DRAFT_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { FAKE_API_KEY, fakeProviderSettings, readAdminAgent, useFakeProvider } from "./support/agent";
import {
	autoReadFields,
	createSharedMailbox,
	createSignedInAccount,
	okJson,
	readMailboxSettings,
	shareMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { QUESTION_DRAFT_BODY } from "./support/fake-model-scenarios";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

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
