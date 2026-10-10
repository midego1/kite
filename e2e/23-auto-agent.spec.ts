import { expect, test, type APIRequestContext } from "@playwright/test";
import { DRAFT_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { FAKE_API_KEY, fakeProviderSettings, readAdminAgent, useFakeProvider } from "./support/agent";
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
