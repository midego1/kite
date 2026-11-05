import { expect, test, type APIRequestContext } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import {
	beginAutoReadSnapshot,
	createSignedInAccount,
	okJson,
	restoreAutoReadSnapshot,
	selectMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

// "No AI for this mailbox": with the switch on, chat, Summarize, Write with Kite and automatic reading send nothing
// carrying the mailbox's mail to the model, while another mailbox keeps working. Asserted on what the fake model
// received.

let api: APIRequestContext;
let fake: FakeModel;
let restore: () => Promise<void>;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	await beginAutoReadSnapshot(api);
	fake = await startFakeModel();
	restore = await useFakeProvider(api, fake);
});

test.afterAll(async () => {
	await restore?.();
	await restoreAutoReadSnapshot();
	await fake?.close();
	await api?.dispose();
});

type Account = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };

async function newAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	// Automatic reading on, so a delivered message would be read if the switch did not stop it.
	await okJson(
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
	);
	return { ...account, address: `${username}@${DOMAIN}` };
}

const carrying = (token: string) => fake.requests().filter((request) => JSON.stringify(request.body).includes(token));

test.describe("No AI for this mailbox", () => {
	test("nothing from the mailbox reaches the model, and another mailbox still works", async ({ browser }) => {
		const off = await newAccount("noai");
		const on = await newAccount("withai");
		const marker = uniqueToken("NOAIMARK");
		const visible = uniqueToken("AIOKAY");
		try {
			// Only someone who manages the mailbox may change it; turning it on calls no model.
			fake.clearRequests();
			expect(
				(await on.api.put("/api/agent/settings/ai", { data: { mailboxId: off.mailboxId, aiDisabled: true } })).status(),
			).toBe(403);
			await okJson(
				await off.api.put("/api/agent/settings/ai", { data: { mailboxId: off.mailboxId, aiDisabled: true } }),
			);
			expect(fake.requests()).toHaveLength(0);

			const subjectOff = `Contract ${marker}`;
			const subjectOn = `Lunch ${visible}`;
			await postInbound(api, {
				from: "Sam Rivers <sam@outside.test>",
				to: off.address,
				subject: subjectOff,
				text: `The private terms are ${marker}. Please reply soon.`,
			});
			await postInbound(api, {
				from: "Sam Rivers <sam@outside.test>",
				to: on.address,
				subject: subjectOn,
				text: `Can we have lunch on Tuesday? ${visible}`,
			});
			const messageOff = await waitForMessage(off.api, subjectOff);
			const messageOn = await waitForMessage(on.api, subjectOn);

			// Automatic reading still reads the other mailbox's mail.
			await expect
				.poll(() => fake.requests().filter((request) => request.emailId === messageOn.id).length, { timeout: 30_000 })
				.toBeGreaterThan(0);

			// Chat, Summarize and Write with Kite are refused before any model request.
			const chat = await off.api.post("/api/agent/chat", {
				data: { mailboxId: off.mailboxId, text: `Summarize ${marker}`, currentMessageId: messageOff.id },
			});
			expect(chat.status()).toBe(403);
			expect((await chat.json()).code).toBe("mailbox_ai_off");
			const summary = await off.api.post(`/api/messages/${messageOff.id}/summary`, { data: { scope: "thread" } });
			expect(summary.status()).toBe(403);
			expect((await summary.json()).code).toBe("mailbox_ai_off");
			const compose = await off.api.post("/api/agent/compose", {
				data: { mailboxId: off.mailboxId, mode: "rewrite", action: "formal", text: `Reply about ${marker}` },
			});
			expect(compose.status()).toBe(403);
			expect((await compose.json()).code).toBe("mailbox_ai_off");
			expect(await okJson(await off.api.get(`/api/agent/compose?mailboxId=${off.mailboxId}`))).toEqual({
				available: false,
				reason: "mailbox_ai_off",
			});

			// The other mailbox: chat and Summarize reach the model.
			const chatOn = await on.api.post("/api/agent/chat", {
				data: { mailboxId: on.mailboxId, text: "What is in my inbox?" },
			});
			expect(chatOn.status()).toBe(200);
			await chatOn.text();
			expect((await on.api.post(`/api/messages/${messageOn.id}/summary`, { data: { scope: "thread" } })).status()).toBe(
				200,
			);
			expect(fake.requests().some((request) => request.kind === "summary")).toBe(true);

			// The reader and the composer say why instead of offering the features.
			const context = await browser.newContext({ storageState: await off.api.storageState() });
			const page = await context.newPage();
			try {
				await selectMailbox(page, off.mailboxId);
				await page.goto(`/inbox/${encodeURIComponent(messageOff.id)}`);
				await expect(page.getByTestId("summarize-ai-off")).toBeVisible({ timeout: 30_000 });
				await expect(page.getByRole("button", { name: "Summarize conversation" })).toHaveCount(0);
				const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
				if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click();
				const panel = page.locator("#email-assistant-panel");
				await expect(panel.getByTestId("mailbox-ai-off-notice")).toBeVisible();
				await panel.getByRole("button", { name: "Assistant settings" }).click();
				await expect(panel.getByRole("switch", { name: "No AI for this mailbox" })).toBeChecked();
			} finally {
				await context.close();
			}

			// Nothing the model received carries the mailbox's mail; the other mailbox's did go out.
			expect(carrying(marker)).toEqual([]);
			expect(carrying(visible).length).toBeGreaterThan(0);
			expect(fake.requests().some((request) => request.emailId === messageOff.id)).toBe(false);
			const jobs = await okJson<{ jobs: { kind: string }[] }>(
				await off.api.get(`/api/agent/jobs?mailboxId=${off.mailboxId}`),
			);
			expect(jobs.jobs).toEqual([]);
		} finally {
			await off.api.dispose();
			await on.api.dispose();
		}
	});
});
