import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { beginAutoReadSnapshot, createSignedInAccount, okJson, restoreAutoReadSnapshot } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import type { InboundMail } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption } from "./support/select";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Only Cloudflare's own Authentication-Results are trusted. */
const authFor = (domain: string, result = "pass") => ({
	"Auto-Submitted": "auto-generated",
	"Authentication-Results": `mx.cloudflare.net; spf=${result} smtp.mailfrom=${domain}; dkim=${result} header.d=${domain}; dmarc=${result} header.from=${domain}`,
});

/** A day `days` ago in UTC, as a receipt prints it ("Nov 2, 2026") and as the API stores it. */
function daysAgo(days: number) {
	const date = new Date(Date.now() - days * 86_400_000);
	const printed = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
	return { printed, day: date.toISOString().slice(0, 10) };
}

/**
 * A synthetic receipt of the shape the owner reported: a one-off charge a merchant takes through Stripe, sent from a
 * receipts+acct_ address under Stripe's name. Every value is invented.
 */
function stripeReceipt(merchant: string, paid = daysAgo(1)): Omit<InboundMail, "to"> {
	return {
		from: `Stripe <receipts+acct_${uniqueToken("").slice(-10)}@stripe.com>`,
		subject: `Your ${merchant} receipt [#1114-${uniqueToken("").slice(-4)}]`,
		text: [
			merchant,
			"Receipt #1114-6093",
			"",
			"Amount paid",
			"$500.00",
			"",
			"Date paid",
			paid.printed,
			"",
			"Payment method",
			"Visa - 4242",
			"",
			"Summary",
			`${merchant} signup fee   $500.00`,
		].join("\n"),
		headers: authFor("stripe.com"),
	};
}

function hostingInvoice(vendor: string): Omit<InboundMail, "to"> {
	const domain = `${vendor.toLowerCase()}.test`;
	return {
		from: `${vendor} <invoices@${domain}>`,
		subject: `Invoice INV-${uniqueToken("").slice(-4)} from ${vendor}`,
		text: "Amount due: €120.00\nPlease pay within 14 days.",
		headers: authFor(domain),
	};
}

type PaymentRow = {
	id: string;
	source: string;
	docType: string;
	status: string;
	vendor: string;
	amount: { minor: number; currency: string } | null;
	documentOn: string;
	messageId: string | null;
	origin: string | null;
};
type PaymentList = { payments: PaymentRow[]; scan: { status: string; recorded: number } | null };

async function suggestAccount(prefix: string) {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await okJson(
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
	);
	return { ...account, address: `${username}@${DOMAIN}` };
}

type Account = Awaited<ReturnType<typeof suggestAccount>>;

const listPayments = async (account: Account) => okJson<PaymentList>(await account.api.get("/api/finance/payments"));

async function deliver(account: Account, mail: Omit<InboundMail, "to">) {
	await postInbound(account.api, { ...mail, to: account.address });
	const message = await waitForMessage(account.api, mail.subject, { status: "received" });
	const job = await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
	return { message, job };
}

async function paymentFor(account: Account, messageId: string): Promise<PaymentRow> {
	let found: PaymentRow | undefined;
	await expect
		.poll(async () => {
			found = (await listPayments(account)).payments.find((row) => row.messageId === messageId);
			return !!found;
		})
		.toBe(true);
	return found!;
}

const row = (page: Page, id: string) => page.locator(`[data-payment-row="${id}"]`);

/** The Undo button of the toast that says `text`; earlier toasts may still be on screen. */
const undoIn = (page: Page, text: string) =>
	page.getByRole("status").filter({ hasText: text }).getByRole("button", { name: "Undo" });

async function rowAction(page: Page, id: string, name: string) {
	await row(page, id)
		.getByRole("button", { name: /^Actions for / })
		.click();
	await page.locator("[data-payment-menu]").getByRole("menuitem", { name }).click();
}

test.describe("Money Watch payments", () => {
	test("a one-off Stripe receipt lands in Payments as paid, and rows can be corrected and removed with Undo", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fpay");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const merchant = `Atlas ${uniqueToken("").slice(-4)}`;
			const paid = daysAgo(1);
			const receipt = await deliver(account, stripeReceipt(merchant, paid));
			expect(receipt.job.status).toBe("completed");
			const payment = await paymentFor(account, receipt.message.id);
			expect(payment).toMatchObject({
				source: "payment",
				docType: "payment",
				status: "paid",
				vendor: merchant,
				amount: { minor: 50_000, currency: "USD" },
				documentOn: paid.day,
				origin: "auto",
			});
			// Recorded without a card.
			const { suggestions } = await readSuggestions(account.api, {
				mailboxId: account.mailboxId,
				messageId: receipt.message.id,
			});
			expect(suggestions.filter((item) => item.kind === "subscription")).toEqual([]);

			const vendor = `Hostco${uniqueToken("").slice(-4)}`;
			const bill = await deliver(account, hostingInvoice(vendor));
			const invoice = await paymentFor(account, bill.message.id);
			expect(invoice).toMatchObject({ docType: "invoice", status: "open", amount: { minor: 12_000, currency: "EUR" } });

			const page = await context.newPage();
			await page.goto("/finance?tab=payments");
			await expect(page.locator('[data-finance-tab="payments"]')).toHaveAttribute("aria-current", "page");
			await expect(row(page, payment.id)).toContainText(merchant);
			await expect(row(page, payment.id).locator("[data-payment-amount]")).toHaveText("$500.00");
			await expect(row(page, invoice.id).locator("[data-payment-status-chip]")).toHaveText("Open");
			const month = page.locator(`[data-payment-month="${paid.day.slice(0, 7)}"]`);
			await expect(month.locator('[data-payment-total="USD"]')).toContainText("$500.00");

			await rowAction(page, invoice.id, "Mark as paid");
			await expect(row(page, invoice.id).locator("[data-payment-status-chip]")).toHaveText("Paid");
			await undoIn(page, "Marked as paid").click();
			await expect(row(page, invoice.id).locator("[data-payment-status-chip]")).toHaveText("Open");

			await rowAction(page, payment.id, "Correct…");
			const dialog = page.locator("[data-payment-dialog]");
			await dialog.getByLabel("Amount").fill("450.00");
			await dialog.getByRole("button", { name: "Save changes" }).click();
			await expect(row(page, payment.id).locator("[data-payment-amount]")).toHaveText("$450.00");

			await rowAction(page, payment.id, "Remove");
			await expect(row(page, payment.id)).toHaveCount(0);
			await undoIn(page, `Removed ${merchant}`).click();
			await expect(row(page, payment.id)).toContainText(merchant);

			await chooseOption(page.locator("[data-payment-filters]").getByLabel("Vendor"), vendor);
			await expect(page.locator("[data-payment-row]")).toHaveCount(1);
			await expect(row(page, invoice.id)).toBeVisible();
		} finally {
			await context.close();
			await restore();
		}
	});

	test("marketing mail, a spoofed receipt and a No-AI mailbox record nothing", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fpno");
		try {
			const marketing = await deliver(account, {
				from: "Shop <news@shop.test>",
				subject: `Black Friday: 40% off everything ${uniqueToken("")}`,
				text: "Shop now! Jackets from €49.99. Your receipt for style.",
				headers: { ...authFor("shop.test"), "List-Id": "<news.shop.test>" },
			});
			expect(marketing.job.status).toBe("completed");
			// A receipt that fails authentication goes to Spam, which is never read.
			const spoofed = { ...stripeReceipt("Spoof Shop"), headers: authFor("stripe.com", "fail") };
			await postInbound(account.api, { ...spoofed, to: account.address });
			await waitForMessage(account.api, spoofed.subject);
			// A forwarded copy of a receipt from a personal address is a copy, not the document.
			const original = stripeReceipt("Forward Shop");
			const forwarded = await deliver(account, {
				...original,
				from: "A Person <person.example@forward.test>",
				subject: `Fwd: ${original.subject}`,
				headers: authFor("forward.test"),
			});
			expect(forwarded.job.status).toBe("completed");
			expect((await listPayments(account)).payments).toEqual([]);

			await okJson(
				await account.api.put("/api/agent/settings/ai", { data: { mailboxId: account.mailboxId, aiDisabled: true } }),
			);
			const quiet = stripeReceipt("Quiet Shop");
			await postInbound(account.api, { ...quiet, to: account.address });
			await waitForMessage(account.api, quiet.subject, { status: "received" });
			// No AI for this mailbox: no job is made, so give delivery time to prove nothing is recorded.
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect((await listPayments(account)).payments).toEqual([]);
			// The scan leaves the mailbox out too.
			await okJson(await account.api.post("/api/finance/payments/scan"));
			await expect.poll(async () => (await listPayments(account)).scan?.status).toBe("done");
			expect((await listPayments(account)).payments).toEqual([]);
		} finally {
			await restore();
		}
	});

	test("Scan last 90 days records mail that arrived before automatic reading was on", async ({ browser }) => {
		const username = `fpscan${uniqueToken("")}`;
		const account = await createSignedInAccount(api, username);
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const merchant = `Earlier ${uniqueToken("").slice(-4)}`;
			const mail = stripeReceipt(merchant, daysAgo(3));
			await postInbound(account.api, { ...mail, to: `${username}@${DOMAIN}` });
			const message = await waitForMessage(account.api, mail.subject, { status: "received" });
			await okJson(
				await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
			);

			const page = await context.newPage();
			await page.goto("/finance?tab=payments");
			await expect(page.getByText("No payments yet")).toBeVisible();
			await page.locator("[data-payment-scan]").click();
			await expect(page.locator("[data-payment-row]")).toContainText(merchant, { timeout: 30_000 });
			await expect(page.locator("[data-payment-scan-status]")).toContainText("Last scan: 1 new payment");
			const [found] = (await listPayments({ ...account, address: "" })).payments;
			expect(found).toMatchObject({ messageId: message.id, origin: "scan", status: "paid" });
		} finally {
			await context.close();
		}
	});
});
