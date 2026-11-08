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
import { apiContext, postInbound, suppressMailboxTour, uniqueToken, waitForMessage } from "./support/helpers";
import { createSharedMailbox, shareMailbox } from "./support/auto-read";
import { sendChat } from "./support/chat";
import { E2E_PERSIST_DIR } from "./support/constants";
import { execFileSync } from "node:child_process";

/** Writes directly to the suite's D1 database, as e2e/10-backups.spec.ts does. */
function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	);
}

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
			await suppressMailboxTour(page);
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
				await expect(panel.getByRole("switch", { name: `No AI for ${off.address}` })).toBeChecked();
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

	test("one user with two mailboxes: the chat in one gets no calendar event or subscription from the other", async () => {
		const user = await newAccount("noaitwo");
		const localPart = `noaishared${uniqueToken("")}`;
		const sharedId = await createSharedMailbox(api, localPart);
		await shareMailbox(api, sharedId, user.id, "full_access");
		const hiddenMark = uniqueToken("HIDDENMARK");
		const shownMark = uniqueToken("SHOWNMARK");
		try {
			const subject = `Board meeting ${hiddenMark}`;
			await postInbound(api, {
				from: "Sam Rivers <sam@outside.test>",
				to: `${localPart}@${DOMAIN}`,
				subject,
				text: `Invitation ${hiddenMark}`,
			});
			const invite = await waitForMessage(api, subject, { mailboxId: sharedId });
			await okJson(await user.api.put("/api/agent/settings/ai", { data: { mailboxId: sharedId, aiDisabled: true } }));
			// What an accepted invitation and a Money Watch card from the shared mailbox leave behind, beside the user's own.
			const start = Math.floor(Date.now() / 1000) + 86_400;
			const id = uniqueToken("noai");
			sql(`INSERT INTO calendar_events (id, user_id, mailbox_id, source_message_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at) VALUES
				('evt-hidden-${id}', '${user.id}', NULL, '${invite.id}', 'Board ${hiddenMark}', 'Agenda ${hiddenMark}', 'Room 4', '[]', ${start}, ${start + 3600}, 1, 1),
				('evt-shown-${id}', '${user.id}', NULL, NULL, 'Dentist ${shownMark}', '', '', '[]', ${start + 7200}, ${start + 10800}, 1, 1);
				INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, amount_minor, currency, cycle, source_message_id, created_at, updated_at) VALUES
				('sub-hidden-${id}', '${user.id}', '${sharedId}', 'Vendor ${hiddenMark}', 'vendor-hidden-${id}', 4200, 'EUR', 'monthly', '${invite.id}', 1, 1),
				('sub-shown-${id}', '${user.id}', NULL, 'Gym ${shownMark}', 'gym-${id}', 3000, 'EUR', 'monthly', NULL, 1, 1);`);
			fake.clearRequests();
			const range = {
				start: new Date((start - 3600) * 1000).toISOString(),
				end: new Date((start + 6 * 3600) * 1000).toISOString(),
			};
			fake.scriptChat(
				{
					toolCalls: [
						{ name: "get_schedule", arguments: range },
						{ name: "search_events", arguments: { ...range, query: "Board", limit: 10 } },
						{ name: "list_subscriptions", arguments: { status: "all" } },
					],
				},
				{ content: "Here is your week." },
			);
			const events = await sendChat(user.api, user.mailboxId, "What is coming up, and what do I pay for?");
			expect(events.some((event) => event.type === "done")).toBe(true);
			const sent = fake.requests().map((request) => JSON.stringify(request.body));
			// The second request carries the tool results: the user's own records, nothing from the shared mailbox.
			expect(sent.length).toBeGreaterThanOrEqual(2);
			expect(sent.some((body) => body.includes(`Dentist ${shownMark}`))).toBe(true);
			expect(sent.some((body) => body.includes(`Gym ${shownMark}`))).toBe(true);
			expect(sent.filter((body) => body.includes(hiddenMark))).toEqual([]);
		} finally {
			await user.api.dispose();
		}
	});
});
