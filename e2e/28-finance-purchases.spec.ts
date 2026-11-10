import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { beginAutoReadSnapshot, createSharedMailbox, okJson, restoreAutoReadSnapshot } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { deliver, financeAccount, type Account } from "./support/finance";
import type { InboundMail } from "./support/helpers-types";
import { apiContext, suppressMailboxTour, uniqueToken } from "./support/helpers";
import { createMcpKey, mcpCall } from "./support/mcp";
import { restoreModules, setModuleState } from "./support/modules";
import { chooseOption } from "./support/select";

let fake: FakeModel;
let api: APIRequestContext;
let anonymous: APIRequestContext;

test.beforeAll(async () => {
	fake = await startFakeModel();
	api = await apiContext(STORAGE_STATE);
	anonymous = await apiContext();
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day `days` ago in UTC, as a receipt prints it ("Nov 2, 2026") and as the API stores it. */
function daysAgo(days: number) {
	const date = new Date(Date.now() - days * 86_400_000);
	return {
		printed: `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`,
		day: date.toISOString().slice(0, 10),
	};
}

const authFor = (domain: string) => ({
	"Auto-Submitted": "auto-generated",
	"Authentication-Results": `mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
});

/** An airline receipt: the vendor name makes Travel obvious. Every value is invented. */
function flightReceipt(): Omit<InboundMail, "to"> {
	return {
		from: "KLM Tickets <billing@klm-e2e.test>",
		subject: `Your flight receipt [#KL-${uniqueToken("").slice(-5).toUpperCase()}]`,
		text: `Flight receipt\nAmount paid\n€212.40\nDate paid\n${daysAgo(1).printed}`,
		headers: authFor("klm-e2e.test"),
	};
}

/** A one-off charge through Stripe for a merchant nothing in the mail categorises. */
function stripeReceipt(merchant: string): Omit<InboundMail, "to"> {
	return {
		from: `Stripe <receipts+acct_${uniqueToken("").slice(-10)}@stripe.com>`,
		subject: `Your ${merchant} receipt [#1114-${uniqueToken("").slice(-4)}]`,
		text: `${merchant}\nReceipt #1114-6093\n\nAmount paid\n$500.00\n\nDate paid\n${daysAgo(2).printed}\n\nSummary\n${merchant} signup fee $500.00`,
		headers: authFor("stripe.com"),
	};
}

function hostingInvoice(): Omit<InboundMail, "to"> {
	return {
		from: "Hetzner Cloud <invoices@hetzner-e2e.test>",
		subject: `Invoice INV-${uniqueToken("").slice(-4)} from Hetzner Cloud`,
		text: "Amount due: €120.00\nPlease pay within 14 days.",
		headers: authFor("hetzner-e2e.test"),
	};
}

type PaymentRow = {
	id: string;
	source: string;
	vendor: string;
	status: string;
	category: string | null;
	amount: { minor: number; currency: string } | null;
	messageId: string | null;
};

const listPayments = async (account: Account) =>
	(await okJson<{ payments: PaymentRow[] }>(await account.api.get("/api/finance/payments"))).payments;

async function paymentFor(account: Account, messageId: string): Promise<PaymentRow> {
	let found: PaymentRow | undefined;
	await expect
		.poll(async () => {
			found = (await listPayments(account)).find((row) => row.messageId === messageId);
			return !!found;
		})
		.toBe(true);
	return found!;
}

const row = (page: Page, id: string) => page.locator(`[data-payment-row="${id}"]`);

const undoIn = (page: Page, text: string) =>
	page.getByRole("status").filter({ hasText: text }).getByRole("button", { name: "Undo" });

async function rowAction(page: Page, id: string, name: string) {
	await row(page, id)
		.getByRole("button", { name: /^Actions for / })
		.click();
	await page.locator("[data-payment-menu]").getByRole("menuitem", { name }).click();
}

type Setup = { account: Account; flight: PaymentRow; stripe: PaymentRow; hosting: PaymentRow; merchant: string };

async function recordThree(): Promise<Setup> {
	const account = await financeAccount(api, "fpur", { suggest: true });
	const merchant = `Atlas ${uniqueToken("").slice(-4)}`;
	const flight = await deliver(account, flightReceipt());
	const stripe = await deliver(account, stripeReceipt(merchant));
	const hosting = await deliver(account, hostingInvoice());
	return {
		account,
		merchant,
		flight: await paymentFor(account, flight.message.id),
		stripe: await paymentFor(account, stripe.message.id),
		hosting: await paymentFor(account, hosting.message.id),
	};
}

async function openTab(context: BrowserContext, path = "/finance?tab=payments") {
	const page = await context.newPage();
	await suppressMailboxTour(page);
	await page.goto(path);
	return page;
}

test.describe("Money Watch purchases: categories, export, search and the assistant tool", () => {
	test("a receipt gets a category only where obvious, the owner changes it with Undo, filters by it and exports it", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const { account, flight, stripe, hosting, merchant } = await recordThree();
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			expect([flight.category, stripe.category, hosting.category]).toEqual(["travel", null, "software"]);

			const page = await openTab(context);
			await expect(row(page, flight.id).locator("[data-payment-category]")).toHaveText("Travel");
			await expect(row(page, hosting.id).locator("[data-payment-category]")).toHaveText("Software and online services");
			await expect(row(page, stripe.id).locator("[data-payment-category]")).toHaveCount(0);

			// Change it in the correction dialog; Undo puts it back.
			await rowAction(page, stripe.id, "Correct…");
			const dialog = page.locator("[data-payment-dialog]");
			await expect(dialog.getByLabel("Category")).toBeVisible();
			await chooseOption(dialog.getByLabel("Category"), "Shopping");
			await dialog.getByRole("button", { name: "Save changes" }).click();
			await expect(row(page, stripe.id).locator("[data-payment-category]")).toHaveText("Shopping");
			await undoIn(page, "Payment corrected").click();
			await expect(row(page, stripe.id).locator("[data-payment-category]")).toHaveCount(0);
			await rowAction(page, stripe.id, "Correct…");
			await chooseOption(dialog.getByLabel("Category"), "Entertainment");
			await dialog.getByRole("button", { name: "Save changes" }).click();
			await expect(row(page, stripe.id).locator("[data-payment-category]")).toHaveText("Entertainment");

			// The category filter, including "No category".
			const filters = page.locator("[data-payment-filters]");
			await chooseOption(filters.getByLabel("Category"), "Travel");
			await expect(page.locator("[data-payment-row]")).toHaveCount(1);
			await expect(row(page, flight.id)).toBeVisible();
			await chooseOption(filters.getByLabel("Category"), "Entertainment");
			await expect(page.locator("[data-payment-row]")).toHaveCount(1);
			await expect(row(page, stripe.id)).toContainText(merchant);
			await chooseOption(filters.getByLabel("Category"), "No category");
			await expect(page.locator("[data-payment-row]")).toHaveCount(0);
			await chooseOption(filters.getByLabel("Category"), "Travel");

			// Export CSV downloads what the filter shows, and only that.
			const downloading = page.waitForEvent("download");
			await page.locator("[data-payment-export]").click();
			const download = await downloading;
			expect(download.suggestedFilename()).toMatch(/^money-watch-payments-\d{4}-\d{2}-\d{2}\.csv$/);
			const csv = (await readFile((await download.path())!, "utf8")).replace(/^﻿/, "");
			const lines = csv.trim().split("\r\n");
			expect(lines[0]).toBe("Date,Vendor,Type,Status,Amount,Currency,Category,Source");
			expect(lines).toHaveLength(2);
			expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2},KLM Tickets,payment,paid,212\.40,EUR,travel,mail$/);
		} finally {
			await context.close();
			await restore();
		}
	});

	test("the export route answers with the filters, refuses a bad one and never starts a formula", async () => {
		const restore = await useFakeProvider(api, fake);
		const { account, flight, stripe, hosting } = await recordThree();
		try {
			const fetchCsv = async (query = "") => {
				const response = await account.api.get(`/api/finance/payments/export${query}`);
				expect(response.status(), await response.text()).toBe(200);
				expect(response.headers()["content-type"]).toContain("text/csv");
				expect(response.headers()["content-disposition"]).toContain("attachment");
				expect(response.headers()["cache-control"]).toBe("no-store");
				return (await response.text()).replace(/^﻿/, "").trim().split("\r\n").slice(1);
			};
			expect(await fetchCsv()).toHaveLength(3);
			expect(await fetchCsv("?category=software")).toHaveLength(1);
			expect(await fetchCsv("?category=none")).toHaveLength(1);
			expect(await fetchCsv("?status=open")).toEqual([expect.stringContaining("Hetzner Cloud")]);
			expect(await fetchCsv(`?month=${daysAgo(1).day.slice(0, 7)}&vendor=KLM%20Tickets`)).toHaveLength(1);
			for (const bad of ["?month=2026-13", "?status=lost", "?category=gifts"])
				expect((await account.api.get(`/api/finance/payments/export${bad}`)).status(), bad).toBe(400);
			expect((await anonymous.get("/api/finance/payments/export")).status()).toBe(401);

			// A vendor the sender printed as a formula is neutralised in the file.
			await okJson(
				await account.api.patch(`/api/finance/payments/${encodeURIComponent(stripe.id)}`, {
					data: { fields: { vendor: '=HYPERLINK("https://evil.example","Pay")' } },
				}),
			);
			const formula = (await fetchCsv("?category=none")).find((line) => line.includes("HYPERLINK"));
			expect(formula).toBeDefined();
			expect(formula).toContain(`,"'=HYPERLINK(""https://evil.example"",""Pay"")",`);
			expect(flight.id).not.toBe(hosting.id);

			// Another user's export holds none of it.
			const stranger = await financeAccount(api, "fpurx");
			const theirs = await stranger.api.get("/api/finance/payments/export");
			expect((await theirs.text()).replace(/^﻿/, "").trim().split("\r\n")).toHaveLength(1);
		} finally {
			await restore();
		}
	});

	test("a search result opens the tab on that one payment, and the section lists only the owner's", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const { account, flight } = await recordThree();
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const response = await account.api.get(`/api/search?q=${encodeURIComponent("KLM")}`);
			expect(response.status()).toBe(200);
			const { sections } = (await response.json()) as {
				sections: {
					id: string;
					label: string;
					items: { ref: { kind: string; id: string }; label: string; href: string }[];
				}[];
			};
			const payments = sections.find((section) => section.id === "payments");
			expect(payments?.label).toBe("Payments");
			expect(payments?.items).toHaveLength(1);
			expect(payments!.items[0]).toMatchObject({
				ref: { kind: "finance:payment", id: flight.id },
				label: "KLM Tickets · €212.40",
			});
			const stranger = await financeAccount(api, "fpurs");
			const theirs = (await (await stranger.api.get(`/api/search?q=KLM`)).json()) as { sections: { id: string }[] };
			expect(theirs.sections.map((section) => section.id)).not.toContain("payments");

			const page = await openTab(context, payments!.items[0].href);
			await expect(page.locator("[data-payment-focus]")).toContainText("Showing one payment.");
			await expect(page.locator("[data-payment-export]"), "no export while one payment is shown").toHaveCount(0);
			await expect(page.locator("[data-payment-row]")).toHaveCount(1);
			await expect(row(page, flight.id)).toBeVisible();
			await page.locator("[data-payment-focus]").getByRole("link", { name: "Show all payments" }).click();
			await expect(page.locator("[data-payment-row]")).toHaveCount(3);
			await expect(page.locator("[data-payment-focus]")).toHaveCount(0);
			await expect(page.locator("[data-payment-export]")).toBeVisible();
		} finally {
			await context.close();
			await restore();
		}
	});

	test("list_payments answers over MCP with the filters and totals, and a hook hears of each payment recorded", async () => {
		const restore = await useFakeProvider(api, fake);
		// Webhooks belong to the primary admin, so the receipts arrive in a shared mailbox the admin reviews.
		const local = `fpurt${uniqueToken("")}`;
		const sharedId = await createSharedMailbox(api, local);
		const ownerId = (await okJson<{ user: { id: string } }>(await api.get("/api/auth/me"))).user.id;
		await okJson(
			await api.put("/api/agent/settings", {
				data: { mailboxId: sharedId, reviewerUserId: ownerId, autonomy: "suggest" },
			}),
		);
		const account = { id: ownerId, api, mailboxId: sharedId, address: `${local}@${DOMAIN}` } as Account;
		const hook = await okJson<{ id: string }>(
			await api.post("/api/webhooks", {
				data: {
					url: "https://hooks.e2e-purchases.invalid/receiver",
					events: ["finance.payment.recorded"],
					maxAttempts: 2,
				},
			}),
		);
		const key = await createMcpKey(account.api, "E2E purchases", ["mcp:finance-read"], []);
		try {
			const flight = await deliver(account, flightReceipt());
			const stripe = await deliver(account, stripeReceipt(`Atlas ${uniqueToken("").slice(-4)}`));
			const flightRow = await paymentFor(account, flight.message.id);
			const stripeRow = await paymentFor(account, stripe.message.id);

			const call = async (args: Record<string, unknown> = {}) => {
				const response = await mcpCall(anonymous, key.key, "tools/call", { name: "list_payments", arguments: args });
				expect(response.result?.isError, JSON.stringify(response)).toBeFalsy();
				const [content] = response.result!.content as { text: string }[];
				return JSON.parse(content.text) as {
					payments: {
						ref: { kind: string; id: string };
						vendor: string;
						category: string | null;
						amount: { minor: number };
					}[];
					months: { month: string; currency: string; paidMinor: number }[];
				};
			};
			const all = await call();
			const vendors = all.payments.map((item) => item.vendor);
			// The admin's mailbox may hold payments from other specs; this one's two are among them.
			expect(vendors).toContain("KLM Tickets");
			expect(vendors.some((vendor) => vendor.startsWith("Atlas"))).toBe(true);
			const travel = await call({ category: "travel" });
			expect(travel.payments).toEqual([
				expect.objectContaining({ ref: { kind: "finance:payment", id: flightRow.id }, category: "travel" }),
			]);
			expect(travel.months).toEqual([
				expect.objectContaining({ currency: "EUR", paidMinor: 21_240, month: daysAgo(1).day.slice(0, 7) }),
			]);
			const uncategorised = (await call({ category: "none" })).payments.map((item) => item.vendor);
			expect(uncategorised.some((vendor) => vendor.startsWith("Atlas"))).toBe(true);
			expect(uncategorised).not.toContain("KLM Tickets");
			const refused = await mcpCall(anonymous, key.key, "tools/call", {
				name: "list_payments",
				arguments: { category: "gifts" },
			});
			expect(refused.result?.isError).toBe(true);

			await expect
				.poll(
					async () => {
						const { deliveries } = await okJson<{ deliveries: { eventType: string; payload: string }[] }>(
							await account.api.get(`/api/webhooks/${hook.id}/deliveries?limit=100`),
						);
						return deliveries.filter(
							(delivery) =>
								delivery.eventType === "finance.payment.recorded" &&
								(delivery.payload.includes(flightRow.id) || delivery.payload.includes(stripeRow.id)),
						).length;
					},
					{ timeout: 20_000 },
				)
				.toBe(2);
		} finally {
			await api.delete(`/api/webhooks/${hook.id}`);
			await restore();
		}
	});

	test("with Money Watch off for the user the export, the tool and the search are gone, and back on they return", async () => {
		const restore = await useFakeProvider(api, fake);
		const { account, flight } = await recordThree();
		const key = await createMcpKey(account.api, "E2E purchases off", ["mcp:finance-read"], []);
		const tools = async () => {
			const response = await mcpCall(anonymous, key.key, "tools/list");
			return ((response.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
		};
		const sections = async () =>
			((await (await account.api.get("/api/search?q=KLM")).json()) as { sections: { id: string }[] }).sections.map(
				(section) => section.id,
			);
		try {
			expect(await tools()).toContain("list_payments");
			expect(await sections()).toContain("payments");
			expect((await account.api.get("/api/finance/payments/export")).status()).toBe(200);

			await setModuleState(api, { access: [{ userId: account.id, moduleId: "finance", allowed: false }] });
			expect((await account.api.get("/api/finance/payments/export")).status()).toBe(404);
			expect((await account.api.get("/api/finance/payments")).status()).toBe(404);
			expect(await tools()).not.toContain("list_payments");
			expect(await sections()).not.toContain("payments");

			await setModuleState(api, { access: [{ userId: account.id, moduleId: "finance", allowed: true }] });
			expect(await tools()).toContain("list_payments");
			expect(await sections()).toContain("payments");
			expect((await listPayments(account)).find((item) => item.id === flight.id)?.category).toBe("travel");
		} finally {
			await restoreModules(api, [account.id]);
			await restore();
		}
	});
});
