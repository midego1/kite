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
import { FAKE_ABUSE_CH_KEYS, startFakeAbuseCh } from "./support/fake-abuse-ch";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import type { InboundAttachment } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
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
		await confirmDialog(page, "Report as phishing?").getByRole("button", { name: "Cancel" }).click();
		expect((await waitForMessage(account.api, subject)).status).toBe("received");
		expect(await isBlocked(account, sender)).toBe(false);

		await block.getByRole("button", { name: "Report phishing" }).click();
		const confirm = confirmDialog(page, "Report as phishing?");
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

test("risky no-reply mail keeps its local warning when external reading and all modules are off", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const account = await newAccount("phb");
	let page: Page | undefined;
	try {
		await setModuleState(api, {
			modules: { calendar: false, booking: false, templates: false, import: false, finance: false },
		});
		await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const subject = uniqueToken("phbs");
		await postInbound(account.api, {
			from: "Billing <no-reply@vendor.test>",
			to: account.address,
			subject,
			text: "Please review your statement.",
			html: '<a href="https://collect.phish.test/">https://accounts.good.test/</a>',
		});
		const message = await waitForMessage(account.api, subject);
		expect(await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage")).toMatchObject({
			status: "completed",
			reason: expect.stringContaining("external_provider_not_allowed"),
		});
		const warnings = (await readSuggestions(account.api, { messageId: message.id, status: "open" })).suggestions;
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe("phishing");
		expect(warnings[0].payload.reasons).toContain("displayed_link_mismatch");
		expect(fake.requests()).toHaveLength(0);

		page = await openAs(browser, account);
		await page.goto(`/inbox/${message.id}`);
		await expect(page.locator('[data-suggestion-block="phishing"] [data-phishing-reasons]')).toContainText(
			"A link shows one web address but opens a different one.",
		);
	} finally {
		await page?.context().close();
		await restoreModules(api);
		await okJson(
			await account.api.put("/api/agent/settings", {
				data: { mailboxId: account.mailboxId, autonomy: "off", autoDraftEnabled: false },
			}),
		);
		await account.api.dispose();
		await restore();
	}
});

test("HTML links still produce a warning after a long plain-text part", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const account = await newAccount("phl");
	let page: Page | undefined;
	try {
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const subject = uniqueToken("phls");
		await postInbound(account.api, {
			from: `Billing <${strangerAddress("phl")}>`,
			to: account.address,
			subject,
			text: "Details.\n".repeat(32_000),
			html: '<p>Details.</p><a href="https://127.0.0.1/">Continue</a>',
		});
		const message = await waitForMessage(account.api, subject);
		expect((await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage")).status).toBe("completed");
		const warning = (
			await readSuggestions(account.api, { mailboxId: account.mailboxId, status: "open" })
		).suggestions.find((item) => item.kind === "phishing" && item.messageId === message.id);
		expect(warning?.payload.reasons).toContain("ip_address_url");

		page = await openAs(browser, account);
		await page.goto(`/inbox/${message.id}`);
		await expect(page.locator('[data-suggestion-block="phishing"] [data-phishing-reasons]')).toContainText(
			"A link points to a bare IP address instead of a website name.",
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
		await confirmDialog(page, "Report as phishing?").getByRole("button", { name: "Report phishing" }).click();
		const toast = page
			.getByRole("status")
			.filter({ hasText: `Reported as phishing. Mail from ${sender} now goes to Trash.` });
		await expect(toast).toBeVisible();
		await waitForMessage(account.api, subject, { status: "spam" });
		expect(await isBlocked(account, sender)).toBe(true);

		// Undo moves the message back and lifts the block this report placed.
		await toast.getByRole("button", { name: "Undo" }).click();
		await waitForMessage(account.api, subject, { status: "received" });
		await expect.poll(() => isBlocked(account, sender)).toBe(false);
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
		await page.getByRole("button", { name: "Move to", exact: true }).click();
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

test("Admin General shows that URLhaus and ThreatFox lookups are off without a key, and Test key is owner only", async ({
	browser,
}) => {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
	const page = await context.newPage();
	const errors = collectConsoleErrors(page);
	await page.goto("/general");
	const card = page.locator("[data-threat-lookups]");
	await expect(card.getByText("Threat lookups")).toBeVisible();
	await expect(card.locator("[data-lookup-status=urlhaus]")).toHaveText("URLhaus lookups are off");
	await expect(card.locator("[data-lookup-status=threatfox]")).toHaveText("ThreatFox lookups are off");
	await expect(card).toContainText("URLHAUS_AUTH_KEY");
	await expect(card).toContainText("ABUSE_CH_AUTH_KEY");
	await expect(card.getByRole("button", { name: "Test key" })).toHaveCount(0);
	expect(await okJson<{ threatLookupsConfigured: boolean }>(await api.get("/api/admin/general"))).toMatchObject({
		threatLookupsConfigured: false,
	});

	// Without a key the test makes no lookup; anyone but the owner is refused before that.
	const test = await api.post("/api/admin/threat-lookups/test");
	expect(test.status()).toBe(400);
	expect(await test.json()).toEqual({ error: "No abuse.ch Auth-Key is set" });
	expect((await api.get("/api/admin/threat-lookups/test")).status()).toBe(405);
	const account = await newAccount("phk");
	try {
		expect((await account.api.post("/api/admin/threat-lookups/test")).status()).toBe(403);
	} finally {
		await account.api.dispose();
	}
	expect(errors).toEqual([]);
	await context.close();
});

test("the owner saves an abuse.ch key in Admin General, inbound mail uses it, and it never leaves the server", async ({
	browser,
}) => {
	const abuseCh = await startFakeAbuseCh();
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
	const page = await context.newPage();
	const errors = collectConsoleErrors(page);
	const bodies: Promise<string>[] = [];
	page.on("response", (response) => {
		if (/^\/api\//.test(new URL(response.url()).pathname)) bodies.push(response.text().catch(() => ""));
	});
	const account = await newAccount("phs");
	const keys = Object.values(FAKE_ABUSE_CH_KEYS);
	const leaks = (text: string) => keys.filter((key) => text.includes(key));
	try {
		await page.goto("/general");
		const card = page.locator("[data-threat-lookups]");
		const source = card.locator("[data-key-source]");
		await expect(source).toHaveText("No key");
		await expect(card.getByRole("link", { name: "https://auth.abuse.ch/" })).toHaveAttribute(
			"href",
			"https://auth.abuse.ch/",
		);
		await expect(card).toContainText(
			"The free abuse.ch API is for non-commercial use; commercial use needs a Spamhaus subscription.",
		);
		const field = card.getByLabel("abuse.ch Auth-Key");
		await expect(field).toHaveAttribute("type", "password");

		await field.fill(FAKE_ABUSE_CH_KEYS.rejected);
		await card.getByRole("button", { name: "Save key" }).click();
		await expect(card.getByRole("alert")).toContainText("Key rejected");
		await expect(source).toHaveText("No key");

		await field.fill(FAKE_ABUSE_CH_KEYS.works);
		await card.getByRole("button", { name: "Save key" }).click();
		await expect(card.locator("[data-key-message]")).toHaveText("Key works and is saved");
		await expect(source).toHaveText("Key saved in Kite");
		await expect(field).toHaveValue("");
		await expect(card.locator("[data-lookup-status=urlhaus]")).toHaveText("URLhaus lookups are on");
		await expect(card.locator("[data-lookup-status=threatfox]")).toHaveText("ThreatFox lookups are on");
		await card.getByRole("button", { name: "Test key" }).click();
		await expect(card.locator("[data-key-test] [data-service=urlhaus]")).toHaveText("URLhaus: Key works");
		await expect(card.locator("[data-key-test] [data-service=threatfox]")).toHaveText("ThreatFox: Key works");

		await page.reload();
		await expect(source).toHaveText("Key saved in Kite");
		expect(leaks(await page.content())).toEqual([]);
		const general = await api.get("/api/admin/general");
		expect(leaks(await general.text())).toEqual([]);
		expect((await general.json()).threatLookupKey).toMatchObject({ source: "settings", secretName: null });

		// Risky inbound mail is looked up with the saved key.
		const before = abuseCh.keys.length;
		await deliverFrom(account, strangerAddress("phs"), uniqueToken("phss"), [loginPage]);
		await expect.poll(() => abuseCh.keys.length).toBeGreaterThan(before);
		expect(abuseCh.keys.slice(before).every((key) => key === FAKE_ABUSE_CH_KEYS.works)).toBe(true);

		// When abuse.ch cannot be reached the key is saved anyway, with a warning.
		await field.fill(FAKE_ABUSE_CH_KEYS.unreachable);
		await card.getByRole("button", { name: "Save key" }).click();
		await expect(card.locator("[data-key-message]")).toContainText("abuse.ch could not be reached");
		await expect(source).toHaveText("Key saved in Kite");

		// Only the owner may save, remove or test the key, and only from Kite's own origin.
		const otherAdmin = await createSignedInAccount(api, `phsx${uniqueToken("")}`, "admin");
		try {
			for (const response of [
				await otherAdmin.api.put("/api/admin/threat-lookups/key", { data: { authKey: FAKE_ABUSE_CH_KEYS.works } }),
				await otherAdmin.api.delete("/api/admin/threat-lookups/key"),
				await otherAdmin.api.post("/api/admin/threat-lookups/test"),
			])
				expect(response.status()).toBe(403);
		} finally {
			await otherAdmin.api.dispose();
		}
		const crossOrigin = await api.put("/api/admin/threat-lookups/key", {
			data: { authKey: FAKE_ABUSE_CH_KEYS.works },
			headers: { Origin: "https://attacker.test" },
		});
		expect(crossOrigin.status()).toBe(403);

		await card.getByRole("button", { name: "Remove key" }).click();
		await confirmDialog(page, "Remove the abuse.ch Auth-Key?").getByRole("button", { name: "Remove key" }).click();
		await expect(source).toHaveText("No key");
		await expect(card.locator("[data-lookup-status=urlhaus]")).toHaveText("URLhaus lookups are off");
		await expect(card.getByRole("button", { name: "Test key" })).toHaveCount(0);

		for (const body of await Promise.all(bodies)) expect(leaks(body)).toEqual([]);
		// The refused key answers 400 on purpose, which Chromium logs as a failed resource.
		expect(errors.filter((error) => !/status of 400/.test(error))).toEqual([]);
	} finally {
		await api.delete("/api/admin/threat-lookups/key");
		await account.api.dispose();
		await context.close();
		await abuseCh.close();
	}
});
