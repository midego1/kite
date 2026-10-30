import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Request } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import {
	AUTO_READ_ACCOUNT_PASSWORD,
	beginAutoReadSnapshot,
	collectConsoleErrors,
	createSharedMailbox,
	createSignedInAccount,
	okJson,
	restoreAutoReadSnapshot,
	selectMailbox,
	shareMailbox,
} from "./support/auto-read";
import { chatRequests, firstMailboxId, sendChat, toolNames } from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import {
	AUTH_PASS,
	acceptCard,
	activity,
	cronTick,
	dayFromNow,
	deliver,
	deliverPlain,
	financeAccount,
	invoice,
	isoDay,
	listSubscriptions,
	noticeFrames,
	openRealtimePage,
	reminderEvents,
	subscriptionBlock,
	subscriptionDetail,
	trackRenewing,
	undo,
	uniqueVendor,
	type Account,
	type SubscriptionView,
} from "./support/finance";
import { apiContext, apiSignIn, uniqueToken, waitForBackup, waitForRestore } from "./support/helpers";
import { createMcpKey, mcpCall, mcpToolNames } from "./support/mcp";
import { expectNotFoundPage, expectPaletteCommands } from "./support/module-flows";
import { restoreModules, setModuleState } from "./support/modules";
import { readJobs, readSuggestions } from "./support/triage";
import { chooseOption } from "./support/select";

let fake: FakeModel;
let api: APIRequestContext;
let anonymous: APIRequestContext;

test.beforeAll(async () => {
	fake = await startFakeModel();
	api = await apiContext(STORAGE_STATE);
	anonymous = await apiContext();
	// The dev server compiles the MCP route on its first request, which can outlast a call's 15 s timeout.
	const warm = await anonymous.post("/mcp", { headers: { Origin: "" }, timeout: 120_000 });
	expect(warm.status()).toBe(401);
});

test.afterAll(async () => {
	await anonymous.dispose();
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

const FINANCE_ROUTES = [
	["GET", "/api/finance/subscriptions"],
	["POST", "/api/finance/subscriptions"],
	["GET", "/api/finance/subscriptions/e2e_probe"],
	["PATCH", "/api/finance/subscriptions/e2e_probe"],
	["DELETE", "/api/finance/subscriptions/e2e_probe"],
	["POST", "/api/finance/subscriptions/e2e_probe/documents"],
	["DELETE", "/api/finance/documents/e2e_probe"],
	["POST", "/api/finance/detect"],
	["GET", "/api/finance/badge"],
] as const;
const RENEWAL_DUE = "finance.subscription.renewal_due";
const FINANCE_EVENTS = ["finance.subscription.detected", RENEWAL_DUE];
const MENU_ITEMS = ["Track as subscription", "Add to a tracked subscription"];
const COMMANDS = ["Open Subscriptions", "Add a subscription"];
const HOOK_URL = "https://hooks.e2e-finance.invalid/receiver";

async function expectRoutes(caller: APIRequestContext, status: number) {
	for (const [method, path] of FINANCE_ROUTES) {
		const response = await caller.fetch(path, { method });
		expect(response.status(), `${method} ${path}`).toBe(status);
		if (status === 404) expect(await response.json(), `${method} ${path}`).toEqual({ error: "Not found" });
	}
}

type ToolAnswer = {
	subscriptions: {
		ref: { kind: string; id: string };
		vendor: string;
		plan: string | null;
		amount: { minor: number; currency: string } | null;
		cycle: string | null;
		status: string;
		nextRenewalOn: string | null;
		trialEndsOn: string | null;
		urgent: boolean;
	}[];
	totals: { currency: string; monthlyMinor: number; yearlyMinor: number; paidLast12MonthsMinor: number }[];
};

/** `tools/call list_subscriptions` over MCP with the key, the way an MCP client asks. */
async function listTool(key: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
	const response = await mcpCall(anonymous, key, "tools/call", { name: "list_subscriptions", arguments: args });
	expect(response.result?.isError, JSON.stringify(response)).toBeFalsy();
	const [content] = response.result!.content as { text: string }[];
	return JSON.parse(content.text) as ToolAnswer;
}

async function chatTools(account: { api: APIRequestContext; mailboxId: string }) {
	fake.clearRequests();
	await sendChat(account.api, account.mailboxId, "What do I pay for?");
	const requests = chatRequests(fake);
	expect(requests.length).toBeGreaterThan(0);
	return toolNames(requests[requests.length - 1]);
}

type SearchSection = { id: string; items: { ref: { kind: string; id: string }; href: string }[] };

async function subscriptionSearch(caller: APIRequestContext, query: string) {
	const response = await caller.get(`/api/search?q=${encodeURIComponent(query)}`);
	expect(response.status(), await response.text()).toBe(200);
	const { sections } = (await response.json()) as { sections: SearchSection[] };
	return sections.find((section) => section.id === "subscriptions") ?? null;
}

async function webhookCatalog(): Promise<string[]> {
	const { eventCatalog } = await okJson<{ eventCatalog: { value: string }[] }>(await api.get("/api/webhooks"));
	return eventCatalog.map((event) => event.value);
}

type DeliveryRow = { eventType: string; payload: string };

/** The deliveries of one event type about the subscription, one row per event however often it was retried. */
async function deliveriesFor(webhookId: string, subscriptionId: string, eventType: string) {
	const { deliveries } = await okJson<{ deliveries: DeliveryRow[] }>(
		await api.get(`/api/webhooks/${webhookId}/deliveries?limit=100`),
	);
	return deliveries.filter((row) => row.eventType === eventType && row.payload.includes(subscriptionId)).length;
}

const subscriptionCards = async (account: { api: APIRequestContext }, messageId: string) =>
	(await readSuggestions(account.api, { messageId, status: "all" })).suggestions.filter(
		(item) => item.kind === "subscription",
	);

/** What the API, the tool and the badge say about the account's subscriptions, with each row's documents. */
async function moneyState(account: Account, key: string) {
	const { subscriptions, totals } = await listSubscriptions(account);
	const rows = [];
	for (const row of subscriptions) {
		const { documents } = await subscriptionDetail(account, row.id);
		// An undo writes the old values back, so only the write time may differ.
		rows.push({ row: { ...row, updatedAt: undefined }, documents });
	}
	const { count } = await okJson<{ count: number }>(await account.api.get("/api/finance/badge"));
	const tool = await listTool(key, { status: "all" });
	// The tool must agree with the API on every row and every total.
	expect(tool.subscriptions.map((item) => item.ref.id).sort()).toEqual(subscriptions.map((row) => row.id).sort());
	expect(tool.totals).toEqual(
		(totals as ToolAnswer["totals"]).map(({ currency, monthlyMinor, yearlyMinor, paidLast12MonthsMinor }) => ({
			currency,
			monthlyMinor,
			yearlyMinor,
			paidLast12MonthsMinor,
		})),
	);
	return { rows, totals, tool, badge: count };
}

/** The reader's overflow menu for the open message: the core Snooze entry always, the Money Watch ones only when on. */
async function expectMenuItems(page: Page, on: boolean) {
	await page.getByRole("button", { name: "More actions" }).first().click();
	const menu = page.getByRole("dialog", { name: "More actions" });
	await expect(menu.getByRole("button", { name: "Snooze", exact: true }).first()).toBeVisible();
	for (const label of MENU_ITEMS) {
		const item = page.getByRole("button", { name: label, exact: true });
		if (on) await expect(item, label).toBeVisible();
		else await expect(item, label).toHaveCount(0);
	}
	await page.keyboard.press("Escape");
}

const sidebarItem = (page: Page) => page.getByRole("navigation").first().locator('a[href="/finance"]');

/** First paints on the dev server compile on demand and can take longer than one expect timeout. */
const PAGE_TIMEOUT = 30_000;

/** Resolves with whether the page's next `/api/auth/me` answered, or false when it was aborted or never came. */
function authMeAnswered(page: Page): Promise<boolean> {
	return new Promise((resolve) => {
		const isMe = (request: Request) => new URL(request.url()).pathname === "/api/auth/me";
		const settle = (ok: boolean) => {
			clearTimeout(timer);
			page.off("requestfinished", finished);
			page.off("requestfailed", failed);
			resolve(ok);
		};
		const finished = async (request: Request) => {
			if (isMe(request)) settle((await request.response())?.ok() ?? false);
		};
		const failed = (request: Request) => {
			if (isMe(request)) settle(false);
		};
		const timer = setTimeout(() => settle(false), 60_000);
		page.on("requestfinished", finished);
		page.on("requestfailed", failed);
	});
}

/**
 * Navigates until the page's `/api/auth/me`, which carries the module list, has answered. Until it does the
 * client shows every module, and it gives up after 5 s, which a busy dev server can outlast; an absence
 * check against that placeholder would prove nothing.
 */
async function gotoSignedIn(page: Page, path: string) {
	for (let attempt = 1; ; attempt++) {
		const answered = authMeAnswered(page);
		await page.goto(path);
		if (await answered) return;
		expect(attempt, `/api/auth/me answered on ${path}`).toBeLessThan(3);
	}
}
const withoutResourceErrors = (errors: string[]) =>
	errors.filter((error) => !error.startsWith("Failed to load resource"));

test.describe("Money Watch off means absent", () => {
	test("case 10: install off removes every surface before authentication, runs nothing and keeps the data; on restores it", async ({
		browser,
	}) => {
		test.setTimeout(300_000);
		const restore = await useFakeProvider(api, fake);
		const account = await financeAccount(api, "fgi", { suggest: true });
		const { context, page: live } = await openRealtimePage(browser, account);
		const made = { webhooks: [] as string[], keys: [] as string[], ownerRow: "" };
		try {
			// A row reminded before the switch, whose calendar event must stay through it.
			const early = await trackRenewing(account, uniqueVendor("Earlyflix"));
			await cronTick(api);
			await expect.poll(async () => (await noticeFrames(live)).length, { timeout: 20_000 }).toBe(1);
			const earlyEvents = (await reminderEvents(account, early.id)).map((event) => event.id);
			expect(earlyEvents).toHaveLength(1);

			// A tracked row inside its reminder window, not reminded yet, with an open price-change card.
			const vendor = uniqueVendor("Gateflix");
			const first = await deliver(account, invoice(vendor, dayFromNow(2).long));
			const tracked = await acceptCard(account, first.cards[0].id, "track");
			const later = dayFromNow(32).long;
			const second = await deliver(
				account,
				invoice(vendor, later, { text: `Invoice INV-1002\nPlan: Premium $19.99/month, renews on ${later}.\n` }),
			);
			expect(second.cards).toHaveLength(1);
			const openCard = second.cards[0];
			expect(openCard.payload.event).toBe("price_change");

			const hook = await okJson<{ id: string }>(
				await api.post("/api/webhooks", { data: { url: HOOK_URL, events: FINANCE_EVENTS, maxAttempts: 2 } }),
			);
			made.webhooks.push(hook.id);
			const ownerRow = await trackRenewing({ api, mailboxId: await firstMailboxId(api) }, uniqueVendor("Ownerflix"));
			made.ownerRow = ownerRow.id;
			const key = await createMcpKey(
				account.api,
				"E2E finance gating",
				["mcp:read", "mcp:finance-read"],
				[account.mailboxId],
			);
			made.keys.push(key.id);

			expect(await mcpToolNames(anonymous, key.key)).toContain("list_subscriptions");
			expect(await chatTools(account)).toContain("list_subscriptions");
			expect((await subscriptionSearch(account.api, vendor))?.items.map((item) => item.ref.id)).toEqual([
				tracked.subscription.id,
			]);
			const before = await moneyState(account, key.key);
			expect(before.rows).toHaveLength(2);
			expect(before.tool.subscriptions.map((item) => item.ref.id).sort()).toEqual(
				[early.id, tracked.subscription.id].sort(),
			);

			await setModuleState(api, { modules: { finance: false } });

			await expectRoutes(account.api, 404);
			await expectRoutes(anonymous, 404);
			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			const financeCalls: string[] = [];
			page.on("request", (request) => {
				const { pathname } = new URL(request.url());
				if (pathname.startsWith("/api/finance")) financeCalls.push(pathname);
			});
			await selectMailbox(page, account.mailboxId);
			await gotoSignedIn(page, "/inbox");
			await expect(page.getByRole("button", { name: "Compose" })).toBeVisible({ timeout: PAGE_TIMEOUT });
			await expect(page.getByRole("navigation").first().locator('a[href="/inbox"]').last()).toBeVisible();
			await expect(sidebarItem(page)).toHaveCount(0);
			await expectPaletteCommands(page, "money", COMMANDS, false);
			await expectNotFoundPage(page, "/finance");
			await gotoSignedIn(page, `/inbox/${second.message.id}`);
			await expect(page.getByRole("heading", { name: second.message.subject! })).toBeVisible({ timeout: PAGE_TIMEOUT });
			await expectMenuItems(page, false);
			await expect(subscriptionBlock(page)).toHaveCount(0);
			expect(financeCalls).toEqual([]);

			// The card is hidden but kept, and neither it nor the tracked row can be acted on.
			expect(await subscriptionCards(account, second.message.id)).toEqual([]);
			const refused = await account.api.post(`/api/agent/suggestions/${openCard.id}/accept`, {
				data: { option: "track" },
			});
			expect(refused.status()).toBe(409);
			expect(await refused.json()).toMatchObject({ code: "module_disabled" });
			const undoRefused = await account.api.post(`/api/agent/actions/${tracked.actionId}/undo`);
			expect(undoRefused.status()).toBe(409);
			expect(await undoRefused.json()).toMatchObject({ code: "module_disabled" });
			const trackRow = (await activity(account)).find((item) => item.id === tracked.actionId);
			expect(trackRow?.target).toEqual({ href: null, label: "Subscription" });

			expect(await mcpToolNames(anonymous, key.key)).not.toContain("list_subscriptions");
			const tools = await chatTools(account);
			expect(tools).not.toContain("list_subscriptions");
			expect(tools).toEqual(expect.arrayContaining(["list_emails", "open_page"]));
			const keyRefused = await account.api.post("/api/agent/mcp-keys", {
				data: { name: "off", mailboxIds: [], scopes: ["mcp:finance-read"] },
			});
			expect(keyRefused.status()).toBe(400);
			expect(await keyRefused.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "finance" });
			expect(await subscriptionSearch(account.api, vendor)).toBeNull();
			expect((await webhookCatalog()).filter((event) => FINANCE_EVENTS.includes(event))).toEqual([]);
			for (const event of FINANCE_EVENTS) {
				const hookRefused = await api.post("/api/webhooks", { data: { url: HOOK_URL, events: [event] } });
				expect(hookRefused.status(), event).toBe(400);
				expect(await hookRefused.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "finance" });
			}

			// No detection, no model call and no reminder while off.
			const third = await deliverPlain(account, invoice(vendor, later));
			await cronTick(api);
			await live.waitForTimeout(3_000);
			expect(await noticeFrames(live)).toHaveLength(1);
			expect(await subscriptionCards(account, third.id)).toEqual([]);
			expect(fake.requests().filter((request) => request.emailId === third.id)).toEqual([]);
			expect(
				(await readJobs(account.api, account.mailboxId)).filter((job) => job.sourceMessageId === third.id),
			).toEqual([]);
			expect(await reminderEvents(account, tracked.subscription.id)).toEqual([]);
			expect((await reminderEvents(account, early.id)).map((event) => event.id)).toEqual(earlyEvents);
			expect(await deliveriesFor(hook.id, ownerRow.id, RENEWAL_DUE)).toBe(0);
			expect(withoutResourceErrors(errors)).toEqual([]);

			await setModuleState(api, { modules: { finance: true } });

			expect(await moneyState(account, key.key)).toEqual(before);
			expect((await subscriptionCards(account, second.message.id)).map((item) => [item.id, item.status])).toEqual([
				[openCard.id, "open"],
			]);
			await gotoSignedIn(page, "/inbox");
			await expect(sidebarItem(page)).toBeVisible({ timeout: PAGE_TIMEOUT });
			await expectPaletteCommands(page, "money", COMMANDS, true);
			await gotoSignedIn(page, `/inbox/${second.message.id}`);
			await expect(subscriptionBlock(page)).toHaveCount(1, { timeout: PAGE_TIMEOUT });
			await expectMenuItems(page, true);
			await gotoSignedIn(page, "/finance");
			await expect(page.getByRole("heading", { level: 1, name: "Subscriptions" })).toBeVisible({
				timeout: PAGE_TIMEOUT,
			});
			expect(await mcpToolNames(anonymous, key.key)).toContain("list_subscriptions");
			expect(await chatTools(account)).toContain("list_subscriptions");
			expect(await subscriptionSearch(account.api, vendor)).not.toBeNull();
			expect((await webhookCatalog()).filter((event) => FINANCE_EVENTS.includes(event))).toEqual(FINANCE_EVENTS);

			// The next tick reminds the row that was due while off, once.
			await cronTick(api);
			await expect.poll(async () => (await noticeFrames(live)).length, { timeout: 20_000 }).toBe(2);
			expect((await noticeFrames(live))[1]).toMatchObject({
				notice: "renewal_due",
				href: `/finance?subscription=${tracked.subscription.id}`,
			});
			expect(await reminderEvents(account, tracked.subscription.id)).toHaveLength(1);
			await expect.poll(() => deliveriesFor(hook.id, ownerRow.id, RENEWAL_DUE), { timeout: 20_000 }).toBe(1);
			await cronTick(api);
			await live.waitForTimeout(2_000);
			expect(await noticeFrames(live)).toHaveLength(2);
			expect(await subscriptionCards(account, third.id)).toEqual([]);

			const accepted = await acceptCard(account, openCard.id, "track");
			expect(accepted.subscription.id).toBe(tracked.subscription.id);
		} finally {
			await restoreModules(api);
			if (made.ownerRow) await api.delete(`/api/finance/subscriptions/${made.ownerRow}`);
			for (const id of made.webhooks) await api.delete(`/api/webhooks/${id}`);
			for (const id of made.keys) await account.api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(id)}`);
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 10: a restricted user loses every surface after authentication while the owner and others keep theirs", async ({
		browser,
	}) => {
		test.setTimeout(240_000);
		const restore = await useFakeProvider(api, fake);
		const restricted = await financeAccount(api, "fgr", { suggest: true });
		const other = await financeAccount(api, "fgk");
		const mine = await openRealtimePage(browser, restricted);
		const theirs = await openRealtimePage(browser, other);
		const keys: { api: APIRequestContext; id: string }[] = [];
		const contexts: BrowserContext[] = [];
		try {
			const vendor = uniqueVendor("Restflix");
			const { message, cards } = await deliver(restricted, invoice(vendor, dayFromNow(20).long));
			expect(cards).toHaveLength(1);
			const due = await trackRenewing(restricted, uniqueVendor("Dueflix"));
			const othersDue = await trackRenewing(other, uniqueVendor("Otherflix"));
			const key = await createMcpKey(restricted.api, "E2E finance restricted", ["mcp:finance-read"], []);
			keys.push({ api: restricted.api, id: key.id });
			const ownerKey = await createMcpKey(api, "E2E finance owner", ["mcp:finance-read"], []);
			keys.push({ api, id: ownerKey.id });
			const before = await listSubscriptions(restricted);

			await setModuleState(api, { access: [{ userId: restricted.id, moduleId: "finance", allowed: false }] });

			await expectRoutes(restricted.api, 404);
			await expectRoutes(anonymous, 401);
			expect((await other.api.get("/api/finance/subscriptions")).status()).toBe(200);
			expect((await api.get("/api/finance/subscriptions")).status()).toBe(200);
			const view = await browser.newContext({
				baseURL: BASE_URL,
				storageState: await restricted.api.storageState(),
			});
			contexts.push(view);
			const page = await view.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, restricted.mailboxId);
			await gotoSignedIn(page, "/inbox");
			await expect(page.getByRole("button", { name: "Compose" })).toBeVisible({ timeout: PAGE_TIMEOUT });
			await expect(page.getByRole("navigation").first().locator('a[href="/inbox"]').last()).toBeVisible();
			await expect(sidebarItem(page)).toHaveCount(0);
			await expectPaletteCommands(page, "money", COMMANDS, false);
			await expectNotFoundPage(page, "/finance");
			await gotoSignedIn(page, `/inbox/${message.id}`);
			await expect(page.getByRole("heading", { name: message.subject! })).toBeVisible({ timeout: PAGE_TIMEOUT });
			await expect(subscriptionBlock(page)).toHaveCount(0);
			await expectMenuItems(page, false);
			expect(await subscriptionCards(restricted, message.id)).toEqual([]);
			const refused = await restricted.api.post(`/api/agent/suggestions/${cards[0].id}/accept`, {
				data: { option: "track" },
			});
			expect(refused.status()).toBe(409);
			expect(await refused.json()).toMatchObject({ code: "module_disabled" });

			expect(await mcpToolNames(anonymous, key.key)).not.toContain("list_subscriptions");
			expect(await chatTools(restricted)).not.toContain("list_subscriptions");
			const keyRefused = await restricted.api.post("/api/agent/mcp-keys", {
				data: { name: "off", mailboxIds: [], scopes: ["mcp:finance-read"] },
			});
			expect(keyRefused.status()).toBe(400);
			expect(await keyRefused.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "finance" });
			expect(await subscriptionSearch(restricted.api, vendor)).toBeNull();

			// A personal receipt goes through triage without the step, and Activity says why.
			const personal = await deliver(restricted, {
				from: "Cloudbox <hello@cloudbox.test>",
				subject: `Your Cloudbox subscription ${uniqueToken("sub")}`,
				text: `Hi, your Cloudbox Plus plan is $9.99/month and renews on ${dayFromNow(18).long}.`,
				headers: { "Authentication-Results": AUTH_PASS },
			});
			expect(personal.job.status).toBe("completed");
			expect(personal.job.reason).toContain("module_disabled:finance");
			expect(personal.cards).toEqual([]);
			await page.goto("/kite-activity");
			await expect(page.locator(`[data-activity-skipped="${personal.job.id}"]`)).toContainText(
				"Money Watch is turned off",
			);
			const automatic = await deliverPlain(restricted, invoice(uniqueVendor("Autoflix"), dayFromNow(20).long));

			// The other user's due row is reminded; the restricted user's is not.
			await cronTick(api);
			await expect.poll(async () => (await noticeFrames(theirs.page)).length, { timeout: 20_000 }).toBe(1);
			expect((await noticeFrames(theirs.page))[0].href).toBe(`/finance?subscription=${othersDue.id}`);
			await mine.page.waitForTimeout(2_000);
			expect(await noticeFrames(mine.page)).toEqual([]);
			expect(await subscriptionCards(restricted, automatic.id)).toEqual([]);
			expect(await mcpToolNames(anonymous, ownerKey.key)).toContain("list_subscriptions");
			expect(withoutResourceErrors(errors)).toEqual([]);

			await setModuleState(api, { access: [{ userId: restricted.id, moduleId: "finance", allowed: true }] });
			expect(await listSubscriptions(restricted)).toEqual(before);
			expect((await subscriptionCards(restricted, message.id)).map((item) => item.status)).toEqual(["open"]);
			await gotoSignedIn(page, "/inbox");
			await expect(sidebarItem(page)).toBeVisible({ timeout: PAGE_TIMEOUT });
			expect(await mcpToolNames(anonymous, key.key)).toContain("list_subscriptions");
			await cronTick(api);
			await expect.poll(async () => (await noticeFrames(mine.page)).length, { timeout: 20_000 }).toBe(1);
			expect((await noticeFrames(mine.page))[0].href).toBe(`/finance?subscription=${due.id}`);
		} finally {
			await restoreModules(api, [restricted.id]);
			for (const key of keys) await key.api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(key.id)}`);
			for (const view of contexts) await view.close();
			await mine.context.close();
			await theirs.context.close();
			await restricted.api.dispose();
			await other.api.dispose();
			await restore();
		}
	});
});

test.describe("Money Watch across areas", () => {
	test.use({ timezoneId: "UTC" });

	test("the full lifecycle from a first invoice to cancellation, with every undo consistent across card, API, tool, view, badge and Activity", async ({
		browser,
	}) => {
		test.setTimeout(300_000);
		const restore = await useFakeProvider(api, fake);
		const account = await financeAccount(api, "fgl", { suggest: true });
		const { context, page: live } = await openRealtimePage(browser, account);
		let keyId = "";
		try {
			const key = await createMcpKey(account.api, "E2E finance lifecycle", ["mcp:finance-read"], []);
			keyId = key.id;
			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			const paidOnView = async (text: string | null) => {
				await page.goto("/finance");
				if (text) await expect(page.locator('[data-finance-paid="USD"]')).toHaveText(text);
				else await expect(page.getByText("Money Watch lists the subscriptions you track here")).toBeVisible();
			};
			/** Accepts the card, undoes it, checks every surface is back where it was, and accepts it again. */
			const acceptUndoAccept = async (cardId: string, messageId: string, option: string, paid: string | null) => {
				const before = await moneyState(account, key.key);
				const done = await acceptCard(account, cardId, option);
				await undo(account, done.actionId);
				expect(await moneyState(account, key.key)).toEqual(before);
				await paidOnView(paid);
				expect((await subscriptionCards(account, messageId)).find((item) => item.id === cardId)?.status).toBe("open");
				expect(
					(await readSuggestions(account.api, { mailboxId: account.mailboxId })).suggestions.map((item) => item.id),
				).toContain(cardId);
				expect((await activity(account)).some((item) => item.undoOf === done.actionId)).toBe(true);
				return acceptCard(account, cardId, option);
			};

			const vendor = uniqueVendor("Lifeflix");
			const cancelUrl = `https://${uniqueToken("cancel").toLowerCase()}.example/cancel`;
			const first = await deliver(
				account,
				invoice(vendor, dayFromNow(20).long, {
					headers: {
						"Auto-Submitted": "auto-generated",
						"Authentication-Results": AUTH_PASS,
						"List-Unsubscribe": `<${cancelUrl}>`,
					},
				}),
			);
			expect(first.cards).toHaveLength(1);
			const tracked = await acceptUndoAccept(first.cards[0].id, first.message.id, "track", null);
			const id = tracked.subscription.id;

			const renews = dayFromNow(40).long;
			const second = await deliver(
				account,
				invoice(vendor, renews, {
					text: `Invoice INV-1002\nPlan: Premium $19.99/month, renews on ${renews}.\n`,
					attachments: [
						{
							filename: `invoice-${uniqueToken("pdf")}.pdf`,
							contentType: "application/pdf",
							content: Buffer.from("%PDF-1.4"),
						},
					],
				}),
			);
			expect(second.cards[0].payload.event).toBe("price_change");
			await acceptUndoAccept(second.cards[0].id, second.message.id, "track", "$17.99");

			const refund = await deliver(account, {
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject: `Your ${vendor} refund ${uniqueToken("ref")}`,
				text: "Your refund of $19.99 has been issued to your card.",
				headers: { "Auto-Submitted": "auto-generated", "Authentication-Results": AUTH_PASS },
			});
			expect(refund.cards[0]).toMatchObject({ title: `${vendor} refunded $19.99. Record it?` });
			await acceptUndoAccept(refund.cards[0].id, refund.message.id, "record", "$37.98");
			const recorded = await moneyState(account, key.key);
			expect(recorded.tool.totals).toMatchObject([
				{ currency: "USD", monthlyMinor: 1999, paidLast12MonthsMinor: 1799 },
			]);

			await okJson(
				await account.api.patch(`/api/finance/subscriptions/${id}`, { data: { fields: { nextRenewalOn: isoDay(2) } } }),
			);
			await cronTick(api);
			await expect.poll(async () => (await noticeFrames(live)).length, { timeout: 20_000 }).toBe(1);
			expect(await okJson(await account.api.get("/api/finance/badge"))).toEqual({ count: 1 });
			const [event, ...others] = await reminderEvents(account, id);
			expect(event).toBeDefined();
			expect(others).toEqual([]);

			await context.route(`${new URL(cancelUrl).origin}/**`, (route) =>
				route.fulfill({ contentType: "text/html", body: "<title>Cancel</title>" }),
			);
			await page.goto("/finance");
			const row = page.locator(`[data-finance-row="${id}"]`).first();
			const cancel = row.getByRole("button", { name: /^Cancel before / });
			await expect(cancel).toBeVisible({ timeout: 30_000 });
			const popupOpened = context.waitForEvent("page");
			await cancel.click();
			const popup = await popupOpened;
			await popup.waitForLoadState();
			expect(popup.url()).toBe(cancelUrl);
			await popup.close();
			await row.locator("[data-finance-cancel-prompt]").getByRole("button", { name: "Mark as cancelled" }).click();
			await expect(page.getByRole("status").filter({ hasText: "Marked as cancelled" })).toBeVisible();
			await expect(page.locator(`[data-finance-section="upcoming"] [data-finance-row="${id}"]`)).toHaveCount(0);

			const end = await moneyState(account, key.key);
			expect(end.rows).toHaveLength(1);
			expect(end.rows[0].row.status).toBe("cancelled");
			expect(end.rows[0].documents.map((document) => document.docType).sort()).toEqual([
				"invoice",
				"invoice",
				"refund",
			]);
			expect(end.totals[0].paidLast12MonthsMinor).toBe(1799);
			expect(end.tool.subscriptions.map((item) => [item.ref.id, item.status])).toEqual([[id, "cancelled"]]);
			expect(end.tool.totals[0].paidLast12MonthsMinor).toBe(1799);
			expect((await listTool(key.key)).subscriptions).toEqual([]);
			await chooseOption(page.getByLabel("Show"), "ended");
			await page
				.locator(`[data-finance-section="ended"] [data-finance-row="${id}"]`)
				.getByRole("button", { name: new RegExp(`^${vendor}`) })
				.click();
			await expect(page).toHaveURL(new RegExp(`/finance\\?subscription=${id}$`));
			const drawer = page.locator("[data-finance-drawer]");
			await expect(drawer.locator("[data-finance-drawer-paid]")).toHaveText("$17.99");
			await expect(drawer.locator("[data-finance-document]")).toHaveCount(3);

			await cronTick(api);
			await live.waitForTimeout(2_000);
			expect(await noticeFrames(live)).toHaveLength(1);
			expect(await reminderEvents(account, id)).toEqual([]);
			expect(withoutResourceErrors(errors)).toEqual([]);
		} finally {
			if (keyId) await account.api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(keyId)}`);
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("a shared mailbox never shows another user's spending: no card, rows, search, tool results, badge or ref", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const local = `fgs${uniqueToken("")}`;
		const sharedId = await createSharedMailbox(api, local);
		const member = await createSignedInAccount(api, `fgb${uniqueToken("")}`);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await member.api.storageState() });
		const made = {
			rows: [] as string[],
			webhooks: [] as string[],
			keys: [] as { api: APIRequestContext; id: string }[],
		};
		try {
			const ownerId = (await okJson<{ user: { id: string } }>(await api.get("/api/auth/me"))).user.id;
			await shareMailbox(api, sharedId, member.id, "full_access");
			await okJson(
				await api.put("/api/agent/settings", {
					data: { mailboxId: sharedId, reviewerUserId: ownerId, autonomy: "suggest" },
				}),
			);
			const hook = await okJson<{ id: string }>(
				await api.post("/api/webhooks", { data: { url: HOOK_URL, events: FINANCE_EVENTS, maxAttempts: 2 } }),
			);
			made.webhooks.push(hook.id);
			const reviewer = { id: ownerId, api, mailboxId: sharedId, address: `${local}@${DOMAIN}` } as Account;
			const vendor = uniqueVendor("Shareflix");
			const { message, cards } = await deliver(reviewer, invoice(vendor, dayFromNow(9).long));
			expect(cards).toHaveLength(1);
			const tracked = await acceptCard(reviewer, cards[0].id, "track");
			const id = tracked.subscription.id;
			made.rows.push(id);
			await expect.poll(() => deliveriesFor(hook.id, id, "finance.subscription.detected"), { timeout: 20_000 }).toBe(1);

			expect((await readSuggestions(member.api, { mailboxId: sharedId, status: "all" })).suggestions).toEqual(
				expect.not.arrayContaining([expect.objectContaining({ kind: "subscription" })]),
			);
			const { messages } = await okJson<{ messages: { id: string; agentSuggestions?: unknown }[] }>(
				await member.api.get(`/api/messages?mailboxId=${sharedId}`),
			);
			expect(messages.find((item) => item.id === message.id)?.agentSuggestions).toBeUndefined();
			expect(await listSubscriptions(member)).toEqual({ subscriptions: [], totals: [] });
			expect((await member.api.get(`/api/finance/subscriptions/${id}`)).status()).toBe(404);
			expect(await okJson(await member.api.get("/api/finance/badge"))).toEqual({ count: 0 });
			expect(await subscriptionSearch(member.api, vendor)).toBeNull();
			expect((await subscriptionSearch(api, vendor))?.items.map((item) => item.ref.id)).toEqual([id]);
			const key = await createMcpKey(member.api, "E2E finance shared", ["mcp:finance-read"], []);
			made.keys.push({ api: member.api, id: key.id });
			// MCP results carry the untrusted-content marker (upstream Mailflare #225); nothing else may be in it.
			expect(await listTool(key.key, { status: "all" })).toEqual({
				contentTrust: "untrusted_third_party_content",
				subscriptions: [],
				totals: [],
			});
			const shown = (await activity({ api: member.api, mailboxId: sharedId })).find(
				(item) => item.id === tracked.actionId,
			);
			expect(shown?.target).toEqual({ href: null, label: "Subscription" });
			expect((await member.api.get("/api/webhooks")).status()).toBe(403);

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, sharedId);
			await page.goto(`/inbox/${message.id}`);
			await expect(page.getByRole("heading", { name: message.subject! })).toBeVisible();
			await expect(subscriptionBlock(page)).toHaveCount(0);
			await page.goto("/finance");
			await expect(page.getByText("Money Watch lists the subscriptions you track here")).toBeVisible();
			await expect(page.locator(`[data-finance-row="${id}"]`)).toHaveCount(0);
			await expect(sidebarItem(page)).toContainText("Subscriptions");
			await expect(sidebarItem(page)).not.toContainText(/\d/);
			expect(withoutResourceErrors(errors)).toEqual([]);
		} finally {
			for (const id of made.rows) await api.delete(`/api/finance/subscriptions/${id}`);
			for (const id of made.webhooks) await api.delete(`/api/webhooks/${id}`);
			for (const key of made.keys) await key.api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(key.id)}`);
			await context.close();
			await member.api.dispose();
			await restore();
		}
	});

	test("the search dropdown lists the owner's subscriptions and opens the drawer", async ({ browser }) => {
		const account = await financeAccount(api, "fgd");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = uniqueVendor("Dropflix");
			const { subscription } = await okJson<{ subscription: SubscriptionView }>(
				await account.api.post("/api/finance/subscriptions", {
					data: {
						vendor,
						plan: "Family",
						amountMinor: 1799,
						currency: "USD",
						cycle: "monthly",
						nextRenewalOn: isoDay(12),
						reminderDays: 0,
						calendarReminder: false,
						mailboxId: account.mailboxId,
					},
				}),
			);
			const section = await subscriptionSearch(account.api, vendor);
			expect(section?.items).toEqual([
				expect.objectContaining({
					ref: { kind: "finance:subscription", id: subscription.id },
					label: `${vendor} · $17.99/month`,
					href: `/finance?subscription=${subscription.id}`,
				}),
			]);
			expect(await subscriptionSearch(api, vendor)).toBeNull();

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto("/inbox");
			await page.getByRole("textbox", { name: /Search mail/ }).fill(vendor);
			const subscriptions = page.getByTestId("search-dropdown").locator('[data-search-section="subscriptions"]');
			await expect(subscriptions.getByText("Subscriptions", { exact: true })).toBeVisible();
			await subscriptions.getByRole("option", { name: new RegExp(vendor) }).click();
			await expect(page).toHaveURL(new RegExp(`/finance\\?subscription=${subscription.id}$`));
			await expect(page.locator("[data-finance-drawer]")).toContainText(vendor);
			expect(withoutResourceErrors(errors)).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});
});

type BackupDocument = { includedTables: string[]; tables: Record<string, Record<string, unknown>[]> };

test.describe("Money Watch backups", () => {
	test("case 12: a backup round-trip brings back the subscriptions and their ledger rows, document types and attachments", async ({
		browser,
	}) => {
		test.setTimeout(240_000);
		const restore = await useFakeProvider(api, fake);
		const account = await financeAccount(api, "fgu", { suggest: true });
		let signedIn: APIRequestContext | null = null;
		try {
			const vendor = uniqueVendor("Backflix");
			const first = await deliver(account, invoice(vendor, dayFromNow(10).long));
			const { subscription } = await acceptCard(account, first.cards[0].id, "track");
			const renews = dayFromNow(40).long;
			const second = await deliver(
				account,
				invoice(vendor, renews, {
					text: `Invoice INV-1002\nPlan: Premium $19.99/month, renews on ${renews}.\n`,
					attachments: [
						{
							filename: `invoice-${uniqueToken("pdf")}.pdf`,
							contentType: "application/pdf",
							content: Buffer.from("%PDF-1.4"),
						},
					],
				}),
			);
			await acceptCard(account, second.cards[0].id, "track");
			const refund = await deliver(account, {
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject: `Your ${vendor} refund ${uniqueToken("ref")}`,
				text: "Your refund of $19.99 has been issued to your card.",
				headers: { "Auto-Submitted": "auto-generated", "Authentication-Results": AUTH_PASS },
			});
			await acceptCard(account, refund.cards[0].id, "record");
			const before = await listSubscriptions(account);
			const documents = (await subscriptionDetail(account, subscription.id)).documents;
			expect(documents.map((document) => document.docType).sort()).toEqual(["invoice", "invoice", "refund"]);
			expect(documents.filter((document) => document.attachmentId)).toHaveLength(1);

			const { backupId } = await okJson<{ backupId: string }>(await api.post("/api/backups"));
			const finished = await waitForBackup(api, backupId);
			expect(finished.status, finished.error ?? "").toBe("completed");
			const document = JSON.parse(await (await api.get(`/api/backups/${backupId}/download`)).text()) as BackupDocument;
			for (const table of ["finance_subscriptions", "finance_charges"])
				expect(document.includedTables).toContain(table);
			expect(document.tables.finance_subscriptions.map((row) => row.id)).toContain(subscription.id);
			const charges = document.tables.finance_charges.filter((row) => row.subscription_id === subscription.id);
			expect(charges.map((row) => row.doc_type).sort()).toEqual(["invoice", "invoice", "refund"]);

			await okJson(await account.api.delete(`/api/finance/subscriptions/${subscription.id}`));
			expect((await listSubscriptions(account)).subscriptions).toEqual([]);

			const restored = await api.post("/api/backups/restore", {
				multipart: {
					backup: { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) },
				},
			});
			expect(restored.ok(), await restored.text()).toBe(true);
			const restore = await waitForRestore(api, ((await restored.json()) as { restoreId: string }).restoreId);
			expect(restore.status, restore.error ?? "").toBe("completed");

			signedIn = await apiSignIn(account.address, AUTO_READ_ACCOUNT_PASSWORD);
			const back = { ...account, api: signedIn };
			expect(await listSubscriptions(back)).toEqual(before);
			expect((await subscriptionDetail(back, subscription.id)).documents).toEqual(documents);

			const context = await browser.newContext({ baseURL: BASE_URL, storageState: await signedIn.storageState() });
			try {
				const page = await context.newPage();
				await selectMailbox(page, account.mailboxId);
				await page.goto(`/finance?subscription=${subscription.id}`);
				const entries = page.locator("[data-finance-drawer] [data-finance-document]");
				await expect(entries).toHaveCount(3);
				await expect(entries.filter({ hasText: "Refund" })).toContainText("−$19.99");
				const href = await entries.getByRole("link", { name: "Open document" }).getAttribute("href");
				expect(href).toMatch(new RegExp(`^/api/messages/${second.message.id}/attachments/`));
				expect((await signedIn.get(href!)).status()).toBe(200);
			} finally {
				await context.close();
			}
		} finally {
			await signedIn?.dispose();
			await account.api.dispose();
			await restore();
		}
		// The backup held the owner's session, so the restored database still answers it.
		expect((await api.get("/api/auth/me")).status()).toBe(200);
	});
});
