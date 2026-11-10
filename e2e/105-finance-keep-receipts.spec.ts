import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { beginAutoReadSnapshot, createSignedInAccount, okJson, restoreAutoReadSnapshot } from "./support/auto-read";
import { listItems } from "./support/drive";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import type { InboundMail } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { waitForFinishedJob } from "./support/triage";

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
	await restoreModules(api);
});

/**
 * A one-off receipt of the shape Money Watch detects deterministically: a Stripe-style paid receipt, with its PDF
 * attached (stored once, byte-for-byte, in the raw mail) so the backfill also exercises filing the attachment itself
 * into Drive, not just the mail.
 */
function stripeReceipt(merchant: string): Omit<InboundMail, "to"> {
	const domain = "stripe.com";
	return {
		from: `Stripe <receipts+acct_${uniqueToken("").slice(-10)}@${domain}>`,
		subject: `Your ${merchant} receipt [#${uniqueToken("").slice(-4)}]`,
		text: [merchant, "Receipt #1114-6093", "", "Amount paid", "$19.99", "", "Summary", `${merchant} fee   $19.99`].join(
			"\n",
		),
		headers: {
			"Auto-Submitted": "auto-generated",
			"Authentication-Results": `mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
		},
		attachments: [
			{
				filename: `receipt-${uniqueToken("pdf")}.pdf`,
				contentType: "application/pdf",
				content: Buffer.from("%PDF-1.4"),
			},
		],
	};
}

async function suggestAccount(prefix: string) {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await okJson(
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
	);
	return { ...account, address: `${username}@${DOMAIN}` };
}

type Account = Awaited<ReturnType<typeof suggestAccount>>;
type PaymentRow = { id: string; messageId: string | null };

async function deliverPaidReceipt(account: Account, merchant: string) {
	const mail = stripeReceipt(merchant);
	await postInbound(account.api, { ...mail, to: account.address });
	const message = await waitForMessage(account.api, mail.subject, { status: "received" });
	await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
	let found: PaymentRow | undefined;
	await expect
		.poll(async () => {
			const { payments } = await okJson<{ payments: PaymentRow[] }>(await account.api.get("/api/finance/payments"));
			found = payments.find((row) => row.messageId === message.id);
			return !!found;
		})
		.toBe(true);
	return found!;
}

const row = (page: Page, id: string) => page.locator(`[data-payment-row="${id}"]`);

async function rowAction(page: Page, id: string, name: string) {
	await row(page, id)
		.getByRole("button", { name: /^Actions for / })
		.click();
	await page.locator("[data-payment-menu]").getByRole("menuitem", { name }).click();
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Keep receipts" });

async function openReceiptSettings(page: Page) {
	await page.getByRole("button", { name: "Keep receipts" }).click();
	return settingsDialog(page);
}

async function runBackfillUntilDone(page: Page) {
	const dialog = await openReceiptSettings(page);
	await dialog.getByRole("button", { name: "Save receipts for existing payments" }).click();
	await expect(dialog.getByRole("status")).toContainText("1 filed so far, 0 skipped", { timeout: 15_000 });
	await dialog.getByRole("button", { name: "Close" }).click();
}

/** Runs the backfill to completion through the API alone, never touching `page`, so a page already rendered with
 * `hasReceipts: false` for this row stays exactly as stale as it would after a background sweep filed it. */
async function fileReceiptsInTheBackground(account: Account) {
	await okJson(await account.api.post("/api/finance/receipts/backfill"));
	await expect
		.poll(async () => {
			const { backfill } = await okJson<{ backfill: { status: string } | null }>(
				await account.api.get("/api/finance/receipts"),
			);
			return backfill?.status;
		})
		.toBe("done");
}

test.describe("Keep receipts", () => {
	test("on by default: the backfill files a payment's mail into Drive, and removing it asks first", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("frcpt");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const merchant = `Atlas ${uniqueToken("").slice(-4)}`;
			const payment = await deliverPaidReceipt(account, merchant);

			const page = await context.newPage();
			await page.goto("/finance?tab=payments");
			await expect(row(page, payment.id)).toContainText(merchant);

			const settings = await openReceiptSettings(page);
			await expect(settings.getByRole("switch", { name: "Keep receipts" })).toBeChecked();
			await settings.getByRole("button", { name: "Close" }).click();

			await runBackfillUntilDone(page);

			const root = await listItems(account.api);
			const moneyWatch = root.find((item) => item.name === "Money Watch" && item.kind === "folder");
			expect(moneyWatch).toBeTruthy();
			const receiptsFolder = (await listItems(account.api, `parent=${moneyWatch!.id}`)).find(
				(item) => item.name === "Receipts",
			);
			expect(receiptsFolder).toBeTruthy();
			const yearFolder = (await listItems(account.api, `parent=${receiptsFolder!.id}`))[0];
			expect(yearFolder?.kind).toBe("folder");
			const files = await listItems(account.api, `parent=${yearFolder!.id}`);
			const forMerchant = files.filter((item) => item.name.includes(merchant));
			// eml and the PDF built from the text body (this receipt has no HTML part), plus the receipt's own
			// attached PDF, copied independently.
			expect(forMerchant.map((item) => item.name.split(".").pop()).sort()).toEqual(["eml", "pdf", "pdf"]);

			await page.reload();
			await rowAction(page, payment.id, "Remove");
			const confirm = page.getByRole("alertdialog", {
				name: "Remove this, even though it may have saved copies in Drive?",
			});
			await expect(confirm).toBeVisible();
			await confirm.getByRole("button", { name: "Cancel" }).click();
			await expect(row(page, payment.id)).toBeVisible();

			await rowAction(page, payment.id, "Remove");
			await page
				.getByRole("alertdialog", { name: "Remove this, even though it may have saved copies in Drive?" })
				.getByRole("button", { name: "Remove" })
				.click();
			await expect(row(page, payment.id)).toHaveCount(0);

			// The Drive copy is never removed with the row.
			const filesAfter = await listItems(account.api, `parent=${yearFolder!.id}`);
			expect(filesAfter.length).toBe(files.length);
		} finally {
			await context.close();
			await restore();
		}
	});

	test("Drive turned off: the setting says so instead of offering the switch", async ({ browser }) => {
		const account = await suggestAccount("frcptoff");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			await setModuleState(api, { modules: { drive: false } });
			const page = await context.newPage();
			await page.goto("/finance?tab=payments");
			const dialog = await openReceiptSettings(page);
			await expect(dialog).toContainText("Drive is turned off, so no copies are saved.");
			await expect(dialog.getByRole("switch", { name: "Keep receipts" })).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	test("a receipt filed after the list loaded still asks before removing, instead of silently acknowledging a delete the user never confirmed", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("frcptstale");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const merchant = `Harbor ${uniqueToken("").slice(-4)}`;
			const payment = await deliverPaidReceipt(account, merchant);

			const page = await context.newPage();
			await page.goto("/finance?tab=payments");
			await expect(row(page, payment.id)).toContainText(merchant);

			// The backfill runs entirely through the API: this page's row keeps the `hasReceipts: false` it loaded
			// with, exactly as it would if the automatic sweep had filed the receipt in the background.
			await fileReceiptsInTheBackground(account);

			await rowAction(page, payment.id, "Remove");
			const confirm = page.getByRole("alertdialog", {
				name: "Remove this, even though it may have saved copies in Drive?",
			});
			await expect(confirm).toBeVisible();
			await confirm.getByRole("button", { name: "Cancel" }).click();
			await expect(row(page, payment.id)).toBeVisible();

			await rowAction(page, payment.id, "Remove");
			await page
				.getByRole("alertdialog", { name: "Remove this, even though it may have saved copies in Drive?" })
				.getByRole("button", { name: "Remove" })
				.click();
			await expect(row(page, payment.id)).toHaveCount(0);

			const root = await listItems(account.api);
			const moneyWatch = root.find((item) => item.name === "Money Watch" && item.kind === "folder");
			const receiptsFolder = (await listItems(account.api, `parent=${moneyWatch!.id}`)).find(
				(item) => item.name === "Receipts",
			);
			const yearFolder = (await listItems(account.api, `parent=${receiptsFolder!.id}`))[0];
			const filesAfter = (await listItems(account.api, `parent=${yearFolder!.id}`)).filter((item) =>
				item.name.includes(merchant),
			);
			expect(filesAfter.length).toBeGreaterThan(0);
		} finally {
			await context.close();
			await restore();
		}
	});
});
