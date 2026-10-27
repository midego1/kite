import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { createSharedMailbox, createSignedInAccount, okJson, selectMailbox, shareMailbox } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import {
	SUMMARY_DUTCH_OVERVIEW,
	SUMMARY_OVERVIEW,
	SUMMARY_POINT,
	SUMMARY_TRANSLATED_OVERVIEW,
} from "./support/fake-model-scenarios";
import type { FakeModel, FakeRecordedRequest } from "./support/fake-model-types";
import type { StoredMessage } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { setScreener } from "./support/screener";

let api: APIRequestContext;
let fake: FakeModel;
let restore: () => Promise<void>;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	fake = await startFakeModel();
	restore = await useFakeProvider(api, fake);
});

test.afterAll(async () => {
	await restore?.();
	await fake?.close();
	await api?.dispose();
});

test.beforeEach(() => {
	fake.clearRequests();
	fake.resetDefaultScenario();
});

type Account = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };

type SummaryBody = {
	summary: {
		scope: string;
		language: string;
		overview: string;
		points: { label: string; text: string }[];
		stale: boolean;
	} | null;
	translation: { language: string; overview: string } | null;
	translatable: boolean;
	eligible: boolean;
	reason?: string;
};

/** Automatic reading stays off, so the only model requests are the ones these tests make. */
async function autonomyOff(client: APIRequestContext, mailboxId: string) {
	await okJson(await client.put("/api/agent/settings", { data: { mailboxId, autonomy: "off" } }));
}

async function newAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await autonomyOff(account.api, account.mailboxId);
	return { ...account, address: `${username}@${DOMAIN}` };
}

const summaryRequests = () => fake.requests().filter((request) => request.kind === "summary");
const translationRequests = () => fake.requests().filter((request) => request.kind === "summary_translation");

function promptText(request: FakeRecordedRequest): string {
	const messages = (request.body as { messages: { role: string; content: string }[] }).messages;
	return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

type Conversation = { messages: StoredMessage[]; lastMessageId: string; subject: string };

/** Delivers `bodies` to `to` as one conversation, each a reply to the one before (or to `after`). */
async function deliverConversation(
	client: APIRequestContext,
	to: string,
	bodies: string[],
	after?: Conversation,
): Promise<Conversation> {
	const subject = after?.subject ?? uniqueToken("Budget review");
	const messages: StoredMessage[] = [...(after?.messages ?? [])];
	let previous = after?.lastMessageId;
	for (const text of bodies) {
		const messageId = `<${uniqueToken("sum")}@outside.test>`;
		const title = messages.length ? `Re: ${subject} ${messages.length}` : subject;
		await postInbound(client, {
			from: "Sam Rivers <sam@outside.test>",
			to,
			subject: title,
			text,
			messageId,
			inReplyTo: previous,
		});
		messages.push(await waitForMessage(client, title));
		previous = messageId;
	}
	return { messages, lastMessageId: previous!, subject };
}

const getSummary = async (client: APIRequestContext, id: string, query = "") =>
	okJson<SummaryBody>(await client.get(`/api/messages/${id}/summary?scope=thread${query}`));

const postSummary = (client: APIRequestContext, id: string, data: Record<string, unknown> = {}) =>
	client.post(`/api/messages/${id}/summary`, { data: { scope: "thread", ...data } });

async function signedInPage(browser: Browser, client: APIRequestContext, mailboxId: string, locale = "en-US") {
	const context = await browser.newContext({ storageState: await client.storageState(), locale });
	const page = await context.newPage();
	await selectMailbox(page, mailboxId);
	return { context, page };
}

const card = (page: Page) => page.getByRole("region", { name: "AI summary" });

const BODIES = [
	"Hi Alex, can we move the budget review to Tuesday at 10:00? I also need the slides before then.",
	"Tuesday works for me. I will send the slides on Monday.",
	"Great, Tuesday at 10:00 it is. See you then.",
];

async function usageSources(mailboxId: string): Promise<string[]> {
	const { rows } = await okJson<{ rows: { mailboxId: string | null; source: string }[] }>(
		await api.get("/api/admin/ai-usage"),
	);
	// Rows of the same second come back in any order.
	return rows
		.filter((row) => row.mailboxId === mailboxId)
		.map((row) => row.source)
		.sort();
}

test.describe("Thread summaries", () => {
	test("Summarize shows the overview and points, is cached, and goes out of date when a message arrives", async ({
		browser,
	}) => {
		const account = await newAccount("sumc");
		const thread = await deliverConversation(account.api, account.address, BODIES);
		const [first, , third] = thread.messages;
		const { context, page } = await signedInPage(browser, account.api, account.mailboxId);
		try {
			await page.goto(`/inbox/${third.id}`);
			await page.getByRole("button", { name: "Summarize conversation" }).click();
			await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
			await expect(card(page)).toContainText(SUMMARY_POINT);
			await expect(card(page)).toContainText("Written by AI (fake-triage), may be wrong");
			expect(summaryRequests()).toHaveLength(1);
			const [request] = summaryRequests();
			expect(request.tools).toEqual([]);
			for (const message of thread.messages) expect(promptText(request)).toContain(`<<<EMAIL id=${message.id} `);

			// Any later visit, from any message of the conversation, shows it with no model call.
			await page.goto(`/inbox/${first.id}`);
			await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
			await page.reload();
			await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
			await page.getByRole("button", { name: "Summarize conversation" }).click();
			await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
			expect(summaryRequests()).toHaveLength(1);
			expect(await usageSources(account.mailboxId)).toEqual(["summary"]);

			// A fourth message: the old text stays, greyed, until someone asks again.
			const longer = await deliverConversation(
				account.api,
				account.address,
				["Could we start at 10:30 instead?"],
				thread,
			);
			await page.reload();
			await expect(card(page)).toContainText("New messages since this summary");
			await expect(card(page)).toHaveAttribute("data-stale", "true");
			expect(summaryRequests()).toHaveLength(1);
			await card(page).getByRole("button", { name: "Summarize again" }).click();
			await expect(card(page)).not.toHaveAttribute("data-stale", "true");
			await expect(card(page)).not.toContainText("New messages since this summary");
			expect(summaryRequests()).toHaveLength(2);
			expect(promptText(summaryRequests()[1])).toContain(`<<<EMAIL id=${longer.messages[3].id} `);

			// Copy and Hide.
			await card(page).getByRole("button", { name: "Hide summary" }).click();
			await expect(card(page)).toHaveCount(0);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("a hostile answer is refused once, then shown without Markdown, unknown links or addresses", async () => {
		const account = await newAccount("sumh");
		try {
			const thread = await deliverConversation(account.api, account.address, [
				"Please pay invoice 42 by Friday. [[scenario:summary-hostile]]",
			]);
			const body = await okJson<SummaryBody>(await postSummary(account.api, thread.messages[0].id));
			// The first answer was a note about the summary; the repair turn was asked for once.
			expect(summaryRequests()).toHaveLength(2);
			expect(promptText(summaryRequests()[1])).toContain("That reply was not usable");
			expect(body.summary?.overview).toBe("Urgent: pay the invoice at today.");
			expect(body.summary?.points).toEqual([{ label: "Next steps", text: "Pay the invoice before Friday." }]);
			expect(JSON.stringify(body)).not.toMatch(/evil\.test|\*\*|##|`/);
		} finally {
			await account.api.dispose();
		}
	});

	test("a Dutch conversation read in an English browser offers a translation, cached until Summarize again", async ({
		browser,
	}) => {
		const account = await newAccount("sumt");
		const thread = await deliverConversation(account.api, account.address, [
			"Hoi Alex, kunnen we de budgetbespreking naar dinsdag verplaatsen? [[scenario:summary-dutch]]",
		]);
		const id = thread.messages[0].id;
		const { context, page } = await signedInPage(browser, account.api, account.mailboxId, "en-GB");
		try {
			await page.goto(`/inbox/${id}`);
			await page.getByRole("button", { name: "Summarize conversation" }).click();
			await expect(card(page)).toContainText(SUMMARY_DUTCH_OVERVIEW);
			await card(page).getByRole("button", { name: "Translate to English" }).click();
			await expect(card(page)).toContainText(SUMMARY_TRANSLATED_OVERVIEW);
			expect(translationRequests()).toHaveLength(1);
			const translation = promptText(translationRequests()[0]);
			// Only the summary goes to the model, never the mail.
			expect(translation).toContain(SUMMARY_DUTCH_OVERVIEW);
			expect(translation).not.toContain("<<<EMAIL");
			expect(translation).not.toContain("budgetbespreking naar dinsdag verplaatsen?");
			await card(page).getByRole("button", { name: "Show original" }).click();
			await expect(card(page)).toContainText(SUMMARY_DUTCH_OVERVIEW);

			await page.reload();
			await expect(card(page)).toContainText(SUMMARY_TRANSLATED_OVERVIEW);
			expect(translationRequests()).toHaveLength(1);
			expect(await usageSources(account.mailboxId)).toEqual(["summary", "summary_translation"]);

			await deliverConversation(account.api, account.address, ["Dinsdag is goed."], thread);
			await page.reload();
			await card(page).getByRole("button", { name: "Summarize again" }).click();
			await expect(card(page)).not.toHaveAttribute("data-stale", "true");
			await expect(card(page)).toContainText(SUMMARY_DUTCH_OVERVIEW);
			await expect(card(page).getByRole("button", { name: "Translate to English" })).toBeVisible();
			expect((await getSummary(account.api, id, "&language=en")).translation).toBeNull();
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("Spam, Trash and the Screener: no button, the route refuses, and a trashed message takes the summary along", async ({
		browser,
	}) => {
		const account = await newAccount("sums");
		try {
			const spam = await deliverConversation(account.api, account.address, ["Cheap watches, buy now."]);
			const spamId = spam.messages[0].id;
			await okJson(await account.api.post(`/api/messages/${spamId}/status`, { data: { status: "spam" } }));
			expect(await getSummary(account.api, spamId)).toMatchObject({
				eligible: false,
				reason: "not_eligible",
				summary: null,
			});
			const refused = await postSummary(account.api, spamId);
			expect(refused.status()).toBe(409);
			expect(await refused.json()).toMatchObject({ code: "not_eligible" });
			const { context, page } = await signedInPage(browser, account.api, account.mailboxId);
			try {
				await page.goto(`/spam/${spamId}`);
				await expect(page.getByText("Cheap watches, buy now.")).toBeVisible();
				await expect(page.getByRole("button", { name: /^Summarize/ })).toHaveCount(0);
			} finally {
				await context.close();
			}

			await setScreener(account.api, account.mailboxId, { enabled: true });
			const subject = uniqueToken("held");
			await postInbound(account.api, {
				from: "New Person <new@stranger.test>",
				to: account.address,
				subject,
				text: "Hello",
			});
			const held = await waitForMessage(account.api, subject, { status: "screening" });
			expect(await getSummary(account.api, held.id)).toMatchObject({ eligible: false, reason: "not_eligible" });
			expect((await postSummary(account.api, held.id)).status()).toBe(409);
			await setScreener(account.api, account.mailboxId, { enabled: false });

			const thread = await deliverConversation(account.api, account.address, BODIES.slice(0, 2));
			await okJson(await postSummary(account.api, thread.messages[1].id));
			expect((await getSummary(account.api, thread.messages[1].id)).summary?.stale).toBe(false);
			await okJson(
				await account.api.post(`/api/messages/${thread.messages[0].id}/status`, { data: { status: "trash" } }),
			);
			expect((await getSummary(account.api, thread.messages[1].id)).summary).toBeNull();
			// Nothing excluded ever reached the model.
			for (const request of summaryRequests()) {
				expect(promptText(request)).not.toContain("Cheap watches");
				expect(promptText(request)).not.toContain(held.id);
			}
		} finally {
			await account.api.dispose();
		}
	});

	test("a read-only user of a shared mailbox sees the cached summary and makes one, charged to the mailbox", async ({
		browser,
	}) => {
		const localPart = uniqueToken("sumshared");
		const mailboxId = await createSharedMailbox(api, localPart);
		await autonomyOff(api, mailboxId);
		const address = `${localPart}@${DOMAIN}`;
		const reader = await createSignedInAccount(api, uniqueToken("sumread"));
		await shareMailbox(api, mailboxId, reader.id, "read_only");
		try {
			const first = await deliverConversation(api, address, BODIES.slice(0, 2));
			const second = await deliverConversation(api, address, ["Separate question about the offsite."]);
			await okJson(await postSummary(api, first.messages[1].id));
			expect(summaryRequests()).toHaveLength(1);

			const { context, page } = await signedInPage(browser, reader.api, mailboxId);
			try {
				await page.goto(`/inbox/${first.messages[0].id}`);
				await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
				expect(summaryRequests()).toHaveLength(1);
				await page.goto(`/inbox/${second.messages[0].id}`);
				await page.getByRole("button", { name: "Summarize conversation" }).click();
				await expect(card(page)).toContainText(SUMMARY_OVERVIEW);
				expect(summaryRequests()).toHaveLength(2);
			} finally {
				await context.close();
			}
			expect(await usageSources(mailboxId)).toEqual(["summary", "summary"]);

			// A user with personal summary instructions gets a summary of their own; the shared one stays.
			await okJson(
				await reader.api.patch("/api/settings/assistant", {
					data: { instructions: { general: "", chat: "", draft: "", summary: "Always mention the slides." } },
				}),
			);
			expect((await getSummary(reader.api, first.messages[0].id)).summary).toBeNull();
			await okJson(await postSummary(reader.api, first.messages[0].id));
			expect(summaryRequests()).toHaveLength(3);
			expect(summaryRequests()[2].body).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system", content: expect.stringContaining("Always mention the slides.") }),
				]),
			});
			expect((await getSummary(api, first.messages[0].id)).summary?.stale).toBe(false);
			expect(summaryRequests()).toHaveLength(3);
		} finally {
			await reader.api.dispose();
		}
	});

	test("over the mailbox's spend cap the card says which cap, the button turns off and nothing reaches the model", async ({
		browser,
	}) => {
		const account = await newAccount("sumcap");
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, dailySpendCapMicros: 0 } }),
		);
		const thread = await deliverConversation(account.api, account.address, BODIES.slice(0, 1));
		const { context, page } = await signedInPage(browser, account.api, account.mailboxId);
		try {
			await page.goto(`/inbox/${thread.messages[0].id}`);
			const button = page.getByRole("button", { name: "Summarize conversation" });
			await button.click();
			await expect(card(page).getByRole("alert")).toHaveText(
				/^Daily AI spend cap reached: this mailbox's \$0\.00 for today is used up\. It resets at 00:00 UTC\./,
			);
			await expect(button).toBeDisabled();
			const refused = await postSummary(account.api, thread.messages[0].id);
			expect(refused.status()).toBe(429);
			expect(await refused.json()).toMatchObject({ code: "spend_cap" });
			expect(summaryRequests()).toHaveLength(0);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("the card reads in Kite, Kite light, Classic and dark mode", async ({ browser }, testInfo) => {
		const account = await newAccount("sumstyle");
		const thread = await deliverConversation(account.api, account.address, BODIES.slice(0, 2));
		await okJson(await postSummary(account.api, thread.messages[1].id));
		const variants = [
			{ name: "kite-dark", style: "kite", theme: "dark" },
			{ name: "kite-light", style: "kite", theme: "light" },
			{ name: "classic-light", style: "classic", theme: "light" },
			{ name: "classic-dark", style: "classic", theme: "dark" },
		];
		try {
			for (const variant of variants) {
				const { context, page } = await signedInPage(browser, account.api, account.mailboxId);
				try {
					await page.addInitScript(({ style, theme }) => {
						localStorage.setItem("kite-style", style);
						localStorage.setItem("kite-theme", theme);
					}, variant);
					await page.goto(`/inbox/${thread.messages[1].id}`);
					await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
					const overview = card(page).getByText(SUMMARY_OVERVIEW);
					await expect(overview).toBeVisible();
					// The text stands out from the page behind the card in every style.
					const [text, background] = await overview.evaluate((element) => {
						// Computed colours may be oklch; a canvas pixel turns any CSS colour into RGB.
						const canvas = document.createElement("canvas").getContext("2d")!;
						const luminance = (color: string) => {
							canvas.clearRect(0, 0, 1, 1);
							canvas.fillStyle = color;
							canvas.fillRect(0, 0, 1, 1);
							const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
							return 0.2126 * r + 0.7152 * g + 0.0722 * b;
						};
						return [
							luminance(getComputedStyle(element).color),
							luminance(getComputedStyle(document.body).backgroundColor),
						];
					});
					expect(Math.abs(text - background), variant.name).toBeGreaterThan(100);
					await expect(page.locator("[data-loading-overlay]")).not.toHaveClass(/opacity-100/);
					await page.screenshot({ path: testInfo.outputPath(`summary-${variant.name}.png`) });
				} finally {
					await context.close();
				}
			}
		} finally {
			await account.api.dispose();
		}
	});

	test("without a session the summary route answers 401", async () => {
		const anonymous = await apiContext();
		try {
			expect((await anonymous.get("/api/messages/any/summary")).status()).toBe(401);
			expect((await anonymous.post("/api/messages/any/summary", { data: { scope: "thread" } })).status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});
});
