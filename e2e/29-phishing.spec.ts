import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import {
	beginAutoReadSnapshot,
	collectConsoleErrors,
	createSignedInAccount,
	okJson,
	restoreAutoReadSnapshot,
	selectMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import type { InboundAttachment } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { readSuggestions, waitForFinishedJob } from "./support/triage";

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

test.beforeEach(async () => {
	fake.clearRequests();
	fake.resetDefaultScenario();
	await beginAutoReadSnapshot(api);
});

test.afterEach(async () => {
	await restoreAutoReadSnapshot();
});

type Account = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };

async function newAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	return { ...account, address: `${username}@${DOMAIN}` };
}

async function openAs(browser: Browser, account: Account): Promise<Page> {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, account.mailboxId);
	await page.addInitScript((id) => localStorage.setItem("kite-session-user", id), account.id);
	await page.addInitScript(() => {
		localStorage.setItem("kite-conversation-view", "off");
		localStorage.setItem("kite-reading-pane", "none");
	});
	return page;
}

/** A sender address nobody else in the suite uses, so blocking it cannot affect another test. */
const strangerAddress = (prefix: string) => `${uniqueToken(prefix)}@phish.test`;

async function deliverFrom(account: Account, from: string, subject: string, attachments?: InboundAttachment[]) {
	await postInbound(account.api, {
		from: `Billing <${from}>`,
		to: account.address,
		subject,
		text: "Your statement is attached. [[scenario:fyi]]",
		attachments,
	});
	return waitForMessage(account.api, subject);
}

async function isBlocked(account: Account, address: string): Promise<boolean> {
	const params = new URLSearchParams({ mailboxId: account.mailboxId, address });
	return (await okJson<{ contact: { blocked: boolean } }>(await account.api.get(`/api/contacts?${params}`))).contact
		.blocked;
}

const rowFor = (page: Page, subject: string) =>
	page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();

const confirmDialog = (page: Page, name: string | RegExp) => page.getByRole("alertdialog", { name });

const loginPage: InboundAttachment = {
	filename: "statement.html",
	contentType: "text/html; charset=utf-8",
	content: `<html><body><p>Sign in to view your statement</p><a href="https://collect.phish.test/">https://accounts.good.test/</a><form action="https://collect.phish.test/post" method="post"><input type="email" name="user"><input type="password" name="pass"><button>View</button></form></body></html>`,
};

test("an attached login page gets a warning whose Report phishing moves the mail to Spam and blocks the sender", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const account = await newAccount("phc");
	try {
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const sender = strangerAddress("phc");
		const subject = uniqueToken("phcs");
		const message = await deliverFrom(account, sender, subject, [loginPage]);
		expect(message.status).toBe("received");
		expect((await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage")).status).toBe("completed");
		const warning = (
			await readSuggestions(account.api, { mailboxId: account.mailboxId, status: "open" })
		).suggestions.find((item) => item.kind === "phishing" && item.messageId === message.id);
		expect(warning).toBeDefined();

		const page = await openAs(browser, account);
		const errors = collectConsoleErrors(page);
		await page.goto(`/inbox/${message.id}`);
		await expect(page.getByRole("heading", { name: subject })).toBeVisible();
		const block = page.locator('[data-suggestion-block="phishing"]');
		await expect(block.locator("[data-phishing-reasons]")).toContainText(
			"An attached web page asks for a password or sends what you type to a website.",
		);
		await expect(block.locator("[data-phishing-reasons]")).toContainText(
			"A link shows one web address but opens a different one.",
		);

		// Cancelling the confirmation changes nothing.
		await block.getByRole("button", { name: "Report phishing" }).click();
		await confirmDialog(page, "Report this message as phishing?").getByRole("button", { name: "Cancel" }).click();
		expect((await waitForMessage(account.api, subject)).status).toBe("received");
		expect(await isBlocked(account, sender)).toBe(false);

		await block.getByRole("button", { name: "Report phishing" }).click();
		const confirm = confirmDialog(page, "Report this message as phishing?");
		await expect(confirm).toContainText("blocks the sender");
		await confirm.getByRole("button", { name: "Report phishing" }).click();
		await expect(page.getByText(`Reported as phishing. Mail from ${sender} now goes to Trash.`)).toBeVisible();

		await waitForMessage(account.api, subject, { status: "spam" });
		expect(await isBlocked(account, sender)).toBe(true);
		const closed = (await readSuggestions(account.api, { mailboxId: account.mailboxId })).suggestions.find(
			(item) => item.id === warning!.id,
		);
		expect(closed?.status).toBe("accepted");

		// The next mail from the blocked sender goes straight to Trash.
		const next = uniqueToken("phcn");
		await postInbound(account.api, { from: `Billing <${sender}>`, to: account.address, subject: next });
		await waitForMessage(account.api, next, { status: "trash" });
		expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		await page.context().close();
	} finally {
		await okJson(
			await account.api.put("/api/agent/settings", {
				data: { mailboxId: account.mailboxId, autonomy: "off", autoDraftEnabled: false },
			}),
		);
		await account.api.dispose();
		await restore();
	}
});

test("entity-encoded links in an attached page still produce a warning", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const account = await newAccount("phe");
	let page: Page | undefined;
	try {
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const subject = uniqueToken("phes");
		const message = await deliverFrom(account, strangerAddress("phe"), subject, [
			{
				filename: "links.html",
				contentType: "text/html",
				content: '<a href="https&#58;//&#49;27.0.0.1/get?a=1&amp;b=2">https&colon;//accounts.good.test/</a>',
			},
		]);
		expect((await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage")).status).toBe("completed");
		const warning = (
			await readSuggestions(account.api, { mailboxId: account.mailboxId, status: "open" })
		).suggestions.find((item) => item.kind === "phishing" && item.messageId === message.id);
		expect(warning?.payload.reasons).toContain("ip_address_url");
		expect(warning?.payload.reasons).toContain("displayed_link_mismatch");

		page = await openAs(browser, account);
		await page.goto(`/inbox/${message.id}`);
		await expect(page.locator('[data-suggestion-block="phishing"] [data-phishing-reasons]')).toContainText(
			"A link points to a bare IP address instead of a website name.",
		);
		await expect(page.locator('[data-suggestion-block="phishing"] [data-phishing-reasons]')).toContainText(
			"A link shows one web address but opens a different one.",
		);
	} finally {
		await page?.context().close();
		await okJson(
			await account.api.put("/api/agent/settings", {
				data: { mailboxId: account.mailboxId, autonomy: "off", autoDraftEnabled: false },
			}),
		);
		await account.api.dispose();
		await restore();
	}
});

test("Report phishing in the reader's More actions menu reports the open message", async ({ browser }) => {
	const account = await newAccount("phm");
	try {
		const sender = strangerAddress("phm");
		const subject = uniqueToken("phms");
		const message = await deliverFrom(account, sender, subject);
		const page = await openAs(browser, account);
		await page.goto(`/inbox/${message.id}`);
		await expect(page.getByRole("heading", { name: subject })).toBeVisible();
		await page.getByRole("button", { name: "More actions" }).click();
		await page.getByRole("dialog", { name: "More actions" }).getByRole("button", { name: "Report phishing" }).click();
		await confirmDialog(page, "Report this message as phishing?")
			.getByRole("button", { name: "Report phishing" })
			.click();
		await expect(page.getByText(`Reported as phishing. Mail from ${sender} now goes to Trash.`)).toBeVisible();
		await waitForMessage(account.api, subject, { status: "spam" });
		expect(await isBlocked(account, sender)).toBe(true);
		await page.context().close();
	} finally {
		await account.api.dispose();
	}
});

test("Report phishing on a selection reports every message and blocks each sender once", async ({ browser }) => {
	const account = await newAccount("phb");
	try {
		const first = strangerAddress("phb1");
		const second = strangerAddress("phb2");
		const subjects = [uniqueToken("phba"), uniqueToken("phbb"), uniqueToken("phbc")];
		await deliverFrom(account, first, subjects[0]);
		await deliverFrom(account, first, subjects[1]);
		await deliverFrom(account, second, subjects[2]);
		const page = await openAs(browser, account);
		await page.goto("/inbox");
		for (const subject of subjects) await rowFor(page, subject).getByRole("checkbox").check();
		await page.getByRole("button", { name: "Move selected messages" }).click();
		await page.getByRole("menuitem", { name: "Report phishing" }).click();
		const confirm = confirmDialog(page, "Report 3 messages as phishing?");
		await expect(confirm).toContainText("blocks the senders");
		await confirm.getByRole("button", { name: "Report phishing" }).click();
		await expect(page.getByText("3 messages reported as phishing. 2 senders are now blocked.")).toBeVisible();
		for (const subject of subjects) await waitForMessage(account.api, subject, { status: "spam" });
		expect(await isBlocked(account, first)).toBe(true);
		expect(await isBlocked(account, second)).toBe(true);
		await page.context().close();
	} finally {
		await account.api.dispose();
	}
});

test("Admin General shows that URLhaus lookups are off without a key", async ({ browser }) => {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
	const page = await context.newPage();
	await page.goto("/general");
	const card = page.locator("[data-threat-lookups]");
	await expect(card.getByText("Threat lookups")).toBeVisible();
	await expect(card.locator("[data-urlhaus-status]")).toHaveText("URLhaus lookups are off");
	await expect(card).toContainText("URLHAUS_AUTH_KEY");
	await context.close();
});
