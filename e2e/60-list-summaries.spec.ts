import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { createSignedInAccount, okJson, openAutoReadSection, selectMailbox } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { LINE_FROM_JOB, LINE_FROM_TRIAGE } from "./support/fake-model-scenarios";
import type { FakeModel, FakeRecordedRequest } from "./support/fake-model-types";
import type { StoredMessage } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { setScreener } from "./support/screener";
import { chooseOption } from "./support/select";
import { readJobs, waitForFinishedJob } from "./support/triage";

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

async function newAccount(prefix: string, settings: Record<string, unknown>): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await okJson(
		await account.api.put("/api/agent/settings", {
			data: { mailboxId: account.mailboxId, listSummaries: true, ...settings },
		}),
	);
	return { ...account, address: `${username}@${DOMAIN}` };
}

// Long enough for a line (at least 280 characters of text).
const LONG_BODY = [
	"Hi Alex, I wanted to check whether Tuesday at ten still works for the quarterly budget review.",
	"Finance asked us to bring the updated slides with the hiring plan and the revised travel budget,",
	"and we should agree on who presents the numbers for the second half before the meeting starts.",
].join(" ");

async function deliver(
	account: Account,
	options: { subject?: string; text?: string; from?: string; headers?: Record<string, string>; status?: string } = {},
): Promise<StoredMessage> {
	const subject = options.subject ?? uniqueToken("Budget");
	await postInbound(account.api, {
		from: options.from ?? "Sam Rivers <sam@outside.test>",
		to: account.address,
		subject,
		text: options.text ?? LONG_BODY,
		headers: options.headers,
	});
	return waitForMessage(account.api, subject, options.status ? { status: options.status } : {});
}

const requestsFor = (id: string, kind?: FakeRecordedRequest["kind"]) =>
	fake.requests().filter((request) => request.emailId === id && (!kind || request.kind === kind));

function systemText(request: FakeRecordedRequest): string {
	const messages = (request.body as { messages: { role: string; content: string }[] }).messages;
	return messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
}

async function lineOf(account: Account, id: string): Promise<string | undefined> {
	const { messages } = await okJson<{ messages: { id: string; lineSummary?: string }[] }>(
		await account.api.get(`/api/messages?mailboxId=${account.mailboxId}&limit=50`),
	);
	return messages.find((message) => message.id === id)?.lineSummary;
}

async function inboxPage(browser: Browser, account: Account) {
	const context = await browser.newContext({ storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, account.mailboxId);
	// The realtime socket starts once the client knows whose session it is.
	await page.addInitScript((id) => localStorage.setItem("kite-session-user", id), account.id);
	return { context, page };
}

const row = (page: Page, subject: string) => page.getByRole("link").filter({ hasText: subject }).first();

test.describe("One-line summaries in the message list", () => {
	test("with automatic reading on, the line comes from the triage request itself and arrives without a reload", async ({
		browser,
	}) => {
		const account = await newAccount("lst", { autonomy: "suggest" });
		const { context, page } = await inboxPage(browser, account);
		try {
			await page.goto("/inbox");
			const subject = uniqueToken("Budget review");
			const message = await deliver(account, { subject, text: `${LONG_BODY} [[scenario:line-question]]` });
			await expect(row(page, subject).locator("[data-line-summary]")).toHaveText(LINE_FROM_TRIAGE);
			await expect(row(page, subject).locator("[data-line-summary]")).toHaveAttribute("title", /quarterly budget/);
			// One request for this message: the triage request carrying the extra key; never a second summary.
			expect(requestsFor(message.id).map((request) => request.kind)).toEqual(["triage"]);
			expect(systemText(requestsFor(message.id)[0])).toContain('"oneLine": optional');
			expect((await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage")).status).toBe("completed");
			expect(await lineOf(account, message.id)).toBe(LINE_FROM_TRIAGE);

			// Short mail keeps its preview, and its triage request does not ask for a line.
			const short = await deliver(account, { text: "Thanks, see you Tuesday." });
			await waitForFinishedJob(account.api, account.mailboxId, short.id, "triage");
			expect(systemText(requestsFor(short.id, "triage")[0])).not.toContain("oneLine");
			expect(await lineOf(account, short.id)).toBeUndefined();

			// Per browser, the preview can come back without touching the mailbox setting.
			await page.goto("/settings/appearance");
			await chooseOption(page.getByLabel("Show AI summaries instead of previews"), { label: "Previews" });
			await page.goto("/inbox");
			await expect(row(page, subject)).toBeVisible();
			await expect(row(page, subject).locator("[data-line-summary]")).toHaveCount(0);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("with automatic reading off, a job of its own writes the line; newsletters need the switch; the daily limit holds", async ({
		browser,
	}) => {
		const account = await newAccount("lso", { autonomy: "off", listSummaryDailyLimit: 2 });
		try {
			const first = await deliver(account);
			expect((await waitForFinishedJob(account.api, account.mailboxId, first.id, "line_summary")).status).toBe(
				"completed",
			);
			expect(requestsFor(first.id).map((request) => request.kind)).toEqual(["line_summary"]);
			expect(await lineOf(account, first.id)).toBe(LINE_FROM_JOB);

			const listHeaders = { "List-Id": "<news.outside.test>", "List-Unsubscribe": "<https://outside.test/u>" };
			const newsletter = await deliver(account, { from: "News <news@outside.test>", headers: listHeaders });
			const skipped = await waitForFinishedJob(account.api, account.mailboxId, newsletter.id, "line_summary");
			expect([skipped.status, skipped.reason]).toEqual(["skipped", "bulk"]);
			expect(requestsFor(newsletter.id)).toEqual([]);
			// Routine skips stay out of the job list the assistant panel shows, so real failures are not crowded out.
			expect((await readJobs(account.api, account.mailboxId)).map((job) => job.kind)).not.toContain("line_summary");
			expect((await readJobs(account.api, account.mailboxId, "line_summary")).map((job) => job.status).sort()).toEqual([
				"completed",
				"skipped",
			]);

			// The switch lives under Summaries in the assistant settings, for people who manage the mailbox.
			const { context, page } = await inboxPage(browser, account);
			await openAutoReadSection(page);
			const section = page.locator("#email-assistant-panel").getByRole("region", { name: "Summaries" });
			await expect(section.getByRole("switch", { name: "One-line summaries in the message list" })).toBeChecked();
			await section.getByRole("switch", { name: "Include newsletters and notifications" }).click();
			await section.getByRole("button", { name: "Save summaries" }).click();
			await expect(section.getByRole("status")).toHaveText("Saved");
			await context.close();

			const second = await deliver(account, { from: "News <news@outside.test>", headers: listHeaders });
			expect((await waitForFinishedJob(account.api, account.mailboxId, second.id, "line_summary")).status).toBe(
				"completed",
			);
			expect(await lineOf(account, second.id)).toBe(LINE_FROM_JOB);

			// Two lines today: the third message keeps its preview and reaches no model.
			const third = await deliver(account);
			const limited = await waitForFinishedJob(account.api, account.mailboxId, third.id, "line_summary");
			expect([limited.status, limited.reason]).toEqual(["skipped", "daily_limit"]);
			expect(requestsFor(third.id)).toEqual([]);
		} finally {
			await account.api.dispose();
		}
	});

	test("mail the Screener holds gets no line until its sender is approved; spam never gets one", async () => {
		const account = await newAccount("lss", { autonomy: "off" });
		try {
			await setScreener(account.api, account.mailboxId, { enabled: true });
			const held = await deliver(account, { from: "New Person <new@stranger.test>", status: "screening" });
			expect(await lineOf(account, held.id)).toBeUndefined();
			expect(requestsFor(held.id)).toEqual([]);
			await okJson(
				await account.api.post("/api/screener/senders", {
					data: { mailboxId: account.mailboxId, address: "new@stranger.test", decision: "approved" },
				}),
			);
			expect((await waitForFinishedJob(account.api, account.mailboxId, held.id, "line_summary")).status).toBe(
				"completed",
			);
			expect(await lineOf(account, held.id)).toBe(LINE_FROM_JOB);
			await setScreener(account.api, account.mailboxId, { enabled: false });

			// Moved to Spam: the line goes with it and the Spam list shows the preview.
			await okJson(await account.api.post(`/api/messages/${held.id}/status`, { data: { status: "spam" } }));
			const { messages } = await okJson<{ messages: { id: string; lineSummary?: string }[] }>(
				await account.api.get(`/api/messages?mailboxId=${account.mailboxId}&status=spam`),
			);
			expect(messages.find((message) => message.id === held.id)?.lineSummary).toBeUndefined();
			await okJson(await account.api.post(`/api/messages/${held.id}/status`, { data: { status: "received" } }));
			expect(await lineOf(account, held.id)).toBeUndefined();
		} finally {
			await account.api.dispose();
		}
	});

	test("off by default: no line job and no extra key in the triage request", async () => {
		const username = `lsd${uniqueToken("")}`;
		const created = await createSignedInAccount(api, username);
		const account = { ...created, address: `${username}@${DOMAIN}` };
		try {
			await okJson(
				await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
			);
			const message = await deliver(account);
			await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
			expect(requestsFor(message.id).map((request) => request.kind)).toEqual(["triage"]);
			expect(systemText(requestsFor(message.id)[0])).not.toContain("oneLine");
			expect(await lineOf(account, message.id)).toBeUndefined();
		} finally {
			await account.api.dispose();
		}
	});
});
