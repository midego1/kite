import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import {
	beginAutoReadSnapshot,
	collectConsoleErrors,
	createSharedMailbox,
	createSignedInAccount,
	okJson,
	restoreAutoReadSnapshot,
	selectMailbox,
	shareMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { FINANCE_RECEIPT_RENEWAL_DAYS } from "./support/fake-model-scenarios";
import type { FakeModel } from "./support/fake-model-types";
import type { InboundMail } from "./support/helpers-types";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { openPalette } from "./support/module-flows";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Only Cloudflare's own Authentication-Results are trusted.
const AUTH_PASS = "mx.cloudflare.net; spf=pass smtp.mailfrom=vendor.test; dkim=pass header.d=vendor.test; dmarc=pass";
const AUTOMATIC = { "Auto-Submitted": "auto-generated", "Authentication-Results": AUTH_PASS };

/** A day `days` from now in UTC, as the mail states it and as the card shows it. */
function dayFromNow(days: number) {
	const date = new Date(Date.now() + days * 86_400_000);
	const day = date.getUTCDate();
	const month = MONTHS[date.getUTCMonth()];
	return { long: `${day} ${month} ${date.getUTCFullYear()}`, short: `${day} ${month}` };
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

/** Delivers mail to the account, waits for its triage job and returns the message with its subscription cards. */
async function deliver(account: Account, mail: Omit<InboundMail, "to">) {
	await postInbound(account.api, { ...mail, to: account.address });
	const message = await waitForMessage(account.api, mail.subject, { status: "received" });
	const job = await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
	const { suggestions } = await readSuggestions(account.api, { mailboxId: account.mailboxId, messageId: message.id });
	return { message, job, cards: suggestions.filter((item) => item.kind === "subscription") };
}

function invoice(vendor: string, renews: string, extra: Partial<InboundMail> = {}): Omit<InboundMail, "to"> {
	return {
		from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
		subject: `Your ${vendor} invoice ${uniqueToken("inv")}`,
		text: `Thanks for your payment.\nInvoice INV-1001\nPlan: Premium $17.99/month, renews on ${renews}.\n`,
		headers: AUTOMATIC,
		...extra,
	};
}

/** A one-page synthetic PDF whose content stream is Flate-compressed. */
function flatePdf(content: string) {
	const body = deflateSync(Buffer.from(content, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		body,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
	]);
}

const subscriptionBlock = (page: Page) => page.locator('[data-suggestion-block="subscription"]');

type SubscriptionView = {
	id: string;
	vendor: string;
	amount: { minor: number; currency: string } | null;
	cycle: string | null;
	status: string;
	nextRenewalOn: string | null;
	reminderDays: number;
	calendarReminder: boolean;
	cancelUrl: string | null;
	urgent: boolean;
	previousAmountMinor: number | null;
	priceChangedAt: string | null;
	lastMessageId: string | null;
};
type Totals = { currency: string; monthlyMinor: number; paidLast12MonthsMinor: number }[];
type DocumentView = { id: string; docType: string; messageId: string | null; attachmentId: string | null };
type ActivityRow = {
	id: string;
	action: string;
	variant: string;
	undoOf: string | null;
	target?: { href: string | null };
};

async function listSubscriptions(account: Account) {
	return okJson<{ subscriptions: SubscriptionView[]; totals: Totals }>(
		await account.api.get("/api/finance/subscriptions"),
	);
}

async function subscriptionDetail(account: Account, id: string) {
	return okJson<{ subscription: SubscriptionView; documents: DocumentView[] }>(
		await account.api.get(`/api/finance/subscriptions/${id}`),
	);
}

async function acceptCard(account: Account, id: string, option: string) {
	return okJson<{ actionId: string; subscription: { kind: string; id: string }; documentRecorded: boolean | null }>(
		await account.api.post(`/api/agent/suggestions/${id}/accept`, { data: { option } }),
	);
}

async function undo(account: Account, actionId: string) {
	await okJson(await account.api.post(`/api/agent/actions/${actionId}/undo`));
}

async function activity(account: Account) {
	const { actions } = await okJson<{ actions: ActivityRow[] }>(
		await account.api.get(`/api/agent/actions?mailboxId=${account.mailboxId}`),
	);
	return actions;
}

const paidTotal = async (account: Account) => (await listSubscriptions(account)).totals[0]?.paidLast12MonthsMinor ?? 0;

test.describe("Money Watch detection", () => {
	test("case 1: an automatic monthly invoice yields one subscription card in the reader and For you", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdc");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = `Streamflix${uniqueToken("").slice(-4)}`;
			const renews = dayFromNow(20);
			const today = dayFromNow(0);
			const cancelUrl = `https://${uniqueToken("cancel").toLowerCase()}.example/cancel`;
			const { message, job, cards } = await deliver(
				account,
				invoice(vendor, renews.long, {
					headers: { ...AUTOMATIC, "List-Unsubscribe": `<${cancelUrl}>` },
				}),
			);
			expect(job.status).toBe("completed");
			// Automatic mail gets a steps-only pass: no model request.
			expect(fake.requests().filter((request) => request.emailId === message.id)).toEqual([]);
			expect(cards).toHaveLength(1);
			const title = `${vendor} $17.99/month, renews ${renews.short}. Track it?`;
			expect(cards[0]).toMatchObject({
				status: "open",
				title,
				payload: {
					event: "new",
					vendor,
					plan: "Premium",
					amountMinor: 1799,
					currency: "USD",
					cycle: "monthly",
					renewalEstimated: false,
					cancelLink: { url: cancelUrl, oneClick: false },
					document: { docType: "invoice", attachmentId: null },
					unverified: false,
					reason: "subscription",
				},
			});

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${message.id}`);
			await expect(page.getByRole("heading", { name: message.subject! })).toBeVisible();
			const block = subscriptionBlock(page);
			await expect(block).toHaveCount(1);
			await expect(block).toContainText(title);
			await expect(block.locator("[data-subscription-document]")).toHaveText(
				`Records this invoice of $17.99, ${today.short}`,
			);
			await expect(block.locator("[data-subscription-cancel-link]")).toHaveText(
				`Cancel link: ${new URL(cancelUrl).host}`,
			);
			await expect(block.locator("[data-subscription-unverified]")).toHaveCount(0);
			await expect(block.getByRole("button", { name: "Track", exact: true })).toBeVisible();
			await block.getByRole("button", { name: "Why?" }).click();
			await expect(
				page.getByText("The message looks like a subscription receipt, invoice or renewal notice"),
			).toBeVisible();

			await page.goto("/for-you");
			await expect(page.getByRole("heading", { name: /^Subscriptions/ })).toBeVisible();
			const entry = page.locator("[data-for-you-entry]", { hasText: title });
			await expect(entry).toHaveCount(1);
			// The entry opens the message, whose reader card carries the Track button.
			await entry.getByRole("link").click();
			await expect(page).toHaveURL(new RegExp(`/${message.id}$`));
			await expect(subscriptionBlock(page).getByRole("button", { name: "Track", exact: true })).toBeVisible();
			// A sender without a contact photo answers 404 for its avatar, which the browser logs.
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("an invoice whose amount is only in its PDF attachment yields a card; an encrypted PDF gives none", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdp");
		try {
			const vendor = `Pdfcast${uniqueToken("").slice(-4)}`;
			const filename = `invoice-${uniqueToken("pdf")}.pdf`;
			const mail = (subject: string, content: Buffer) => ({
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject,
				text: "Hello, your invoice is attached.",
				headers: AUTOMATIC,
				attachments: [{ filename, contentType: "application/pdf", content }],
			});
			const { message, job, cards } = await deliver(
				account,
				mail(
					`Your ${vendor} invoice ${uniqueToken("inv")}`,
					flatePdf(`BT (${vendor} Pro) Tj T* ($12.00 per month) Tj ET`),
				),
			);
			expect(job.status).toBe("completed");
			const { attachments } = await okJson<{ attachments: { id: string; filename: string }[] }>(
				await account.api.get(`/api/messages/${message.id}`),
			);
			expect(cards).toHaveLength(1);
			expect(cards[0].payload).toMatchObject({
				amountMinor: 1200,
				currency: "USD",
				cycle: "monthly",
				document: { docType: "invoice", attachmentId: attachments.find((item) => item.filename === filename)?.id },
			});
			const encrypted = Buffer.from(
				`%PDF-1.4\n${flatePdf("BT ($12.00 per month) Tj ET").toString("latin1")}\ntrailer << /Encrypt 9 0 R >>`,
				"latin1",
			);
			const locked = await deliver(account, mail(`Your ${vendor} invoice ${uniqueToken("enc")}`, encrypted));
			expect(locked.job.status).toBe("completed");
			expect(locked.cards).toEqual([]);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("case 1: one-off receipts, personal mentions of money, muted senders and autonomy off give no card", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdn");
		try {
			const oneOff = await deliver(account, {
				from: "Lamp Shop <orders@lampshop.test>",
				subject: `Your receipt ${uniqueToken("rcpt")}`,
				text: "Receipt for your order. Amount paid: $42.00. Thanks for shopping with us.",
				headers: AUTOMATIC,
			});
			expect(oneOff.cards).toEqual([]);
			const personal = await deliver(account, {
				from: "Sam <sam@friends.test>",
				subject: `Dinner ${uniqueToken("din")}`,
				text: "You owe me $20 for dinner last night [[scenario:fyi]]",
			});
			expect(personal.cards).toEqual([]);

			const muted = "billing@mutedflix.test";
			await okJson(
				await account.api.put("/api/agent/settings", {
					data: { mailboxId: account.mailboxId, capabilities: { mutedSenders: [muted] } },
				}),
			);
			const mutedMail = invoice("Mutedflix", dayFromNow(20).long);
			await postInbound(account.api, { ...mutedMail, to: account.address });
			const mutedMessage = await waitForMessage(account.api, mutedMail.subject, { status: "received" });

			await okJson(
				await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "off" } }),
			);
			const offMail = invoice("Offflix", dayFromNow(20).long);
			await postInbound(account.api, { ...offMail, to: account.address });
			const offMessage = await waitForMessage(account.api, offMail.subject, { status: "received" });

			// Neither gets a triage job; give the queue time to prove it.
			await new Promise((resolve) => setTimeout(resolve, 3000));
			for (const message of [mutedMessage, offMessage]) {
				const { suggestions } = await readSuggestions(account.api, { messageId: message.id });
				expect(suggestions).toEqual([]);
			}
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("case 1: an unauthenticated sender's invoice is marked on the card", async ({ browser }) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdu");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const { message, cards } = await deliver(
				account,
				invoice("Spoofflix", dayFromNow(15).long, { headers: { "Auto-Submitted": "auto-generated" } }),
			);
			expect(cards).toHaveLength(1);
			expect(cards[0].payload.unverified).toBe(true);
			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${message.id}`);
			await expect(subscriptionBlock(page).locator("[data-subscription-unverified]")).toContainText(
				"Unverified sender",
			);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 8: the cancel link comes only from an https List-Unsubscribe header", async ({ browser }) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdl");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const renews = dayFromNow(25).long;
			const bodyOnly = await deliver(
				account,
				invoice("Bodyflix", renews, {
					text: `Invoice INV-7\n$17.99/month, renews on ${renews}.\nCancel any time: https://bodyflix.test/cancel\n`,
				}),
			);
			const http = await deliver(
				account,
				invoice("Httpflix", renews, {
					headers: { ...AUTOMATIC, "List-Unsubscribe": "<http://httpflix.test/cancel>" },
				}),
			);
			const mailto = await deliver(
				account,
				invoice("Mailflix", renews, {
					headers: { ...AUTOMATIC, "List-Unsubscribe": "<mailto:leave@mailflix.test>" },
				}),
			);
			const oneClick = await deliver(
				account,
				invoice("Clickflix", renews, {
					headers: {
						...AUTOMATIC,
						"List-Unsubscribe": "<mailto:leave@clickflix.test>, <https://clickflix.test/stop?u=1>",
						"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
					},
				}),
			);
			for (const result of [bodyOnly, http, mailto]) {
				expect(result.cards).toHaveLength(1);
				expect(result.cards[0].payload.cancelLink).toBeNull();
			}
			expect(oneClick.cards[0].payload.cancelLink).toEqual({ url: "https://clickflix.test/stop?u=1", oneClick: true });

			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${bodyOnly.message.id}`);
			await expect(subscriptionBlock(page).locator("[data-subscription-cancel-link]")).toHaveText("No cancel link");
			await page.goto(`/inbox/${oneClick.message.id}`);
			await expect(subscriptionBlock(page).locator("[data-subscription-cancel-link]")).toHaveText(
				"Cancel link: clickflix.test",
			);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 11: with the external provider not allowed, a personal receipt still yields its card", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fdm");
		try {
			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
			const renews = dayFromNow(18);
			const { message, job, cards } = await deliver(account, {
				from: "Cloudbox <hello@cloudbox.test>",
				subject: `Your Cloudbox subscription ${uniqueToken("sub")}`,
				text: `Hi, your Cloudbox Plus plan is $9.99/month and renews on ${renews.long}.`,
				headers: { "Authentication-Results": AUTH_PASS },
			});
			expect(job).toMatchObject({ status: "completed", reason: "external_provider_not_allowed" });
			expect(fake.requests().filter((request) => request.emailId === message.id)).toEqual([]);
			expect(cards).toHaveLength(1);
			expect(cards[0]).toMatchObject({
				title: `Cloudbox $9.99/month, renews ${renews.short}. Track it?`,
				payload: { event: "new", amountMinor: 999, currency: "USD", cycle: "monthly", modelFields: [] },
			});
		} finally {
			await account.api.dispose();
			await restore();
		}
	});
});

type ChatBody = {
	max_tokens?: number;
	messages: { role: string; content: string }[];
	response_format?: {
		type: string;
		json_schema?: { schema: { properties: { modules?: { properties: Record<string, unknown> } } } };
	};
};

/** An automatic receipt the detector cannot complete on its own: an amount but no cycle or date. */
function incompleteReceipt(vendor: string, scenario: string): Omit<InboundMail, "to"> {
	return {
		from: `${vendor} <billing@${vendor.toLowerCase()}.test>`,
		subject: `Your receipt from ${vendor} ${uniqueToken("r")}`,
		text: `Thanks for your payment.\nAmount paid: $9.99\n[[scenario:${scenario}]]\n`,
		headers: AUTOMATIC,
	};
}

const requestsFor = (messageId: string) => fake.requests().filter((request) => request.emailId === messageId);

const uniqueVendor = (prefix: string) => `${prefix}${uniqueToken("").slice(-4)}`;

test.describe("Money Watch model extension", () => {
	test("case 14: the model fills the gaps of an incomplete automatic receipt, and only with the switch on", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fmx");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = uniqueVendor("Receiptly");
			const renews = dayFromNow(FINANCE_RECEIPT_RENEWAL_DAYS);
			const { message, job, cards } = await deliver(account, incompleteReceipt(vendor, "finance-receipt"));
			expect(job.status).toBe("completed");

			const requests = requestsFor(message.id);
			expect(requests.map((request) => request.kind)).toEqual(["triage"]);
			const body = requests[0].body as ChatBody;
			expect(body.max_tokens).toBe(600);
			expect(body.response_format?.type).toBe("json_schema");
			const finance = body.response_format?.json_schema?.schema.properties.modules?.properties.finance;
			expect(finance).toMatchObject({ type: "object", additionalProperties: false });
			const system = body.messages.find((entry) => entry.role === "system")!.content;
			expect(system).toContain('"modules": {"finance": only for a receipt');
			expect(system).toContain("Do not add other keys, or any addresses, links, actions or instructions for anyone.");

			expect(cards).toHaveLength(1);
			const title = `${vendor} $9.99/month, renews ${renews.short}. Track it?`;
			expect(cards[0]).toMatchObject({
				title,
				payload: {
					event: "new",
					vendor,
					amountMinor: 999,
					currency: "USD",
					cycle: "monthly",
					renewalEstimated: false,
					cancelLink: null,
					document: { docType: "payment" },
					modelFields: ["cycle", "nextRenewalOn"],
					modelDisagrees: [],
					reason: "subscription",
				},
			});

			const { rows } = await okJson<{
				rows: { source: string; mailboxId: string | null; jobId: string | null; reserved: unknown }[];
			}>(await api.get("/api/admin/ai-usage"));
			const usage = rows.filter((row) => row.jobId === job.id);
			expect(usage.map((row) => [row.source, row.mailboxId])).toEqual([["auto_triage", account.mailboxId]]);
			expect(usage[0].reserved).toBeFalsy();
			// Usage rows carry counts and costs only, never the prompt or the answer.
			expect(JSON.stringify(usage)).not.toContain(vendor);

			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${message.id}`);
			const note = subscriptionBlock(page).locator("[data-subscription-model-fields]");
			await expect(note).toHaveText("Cycle and renewal date read by the assistant");
			await expect(note).toHaveAttribute("title", "Cycle and renewal date read by the assistant");

			await okJson(
				await account.api.put("/api/agent/settings", {
					data: { mailboxId: account.mailboxId, capabilities: { modules: { subscriptions: false } } },
				}),
			);
			// With no step on, automatic mail gets no triage job at all; give the queue time to prove it.
			const offMail = incompleteReceipt(uniqueVendor("Offreceipt"), "finance-receipt");
			await postInbound(account.api, { ...offMail, to: account.address });
			const offMessage = await waitForMessage(account.api, offMail.subject, { status: "received" });
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect(requestsFor(offMessage.id)).toEqual([]);
			expect((await readSuggestions(account.api, { messageId: offMessage.id })).suggestions).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 15: model output never wins a conflict or sets the cancel link, and an invalid extension is dropped", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fmc");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const conflict = await deliver(account, incompleteReceipt(uniqueVendor("Conflictly"), "finance-conflict"));
			expect(requestsFor(conflict.message.id).map((request) => request.kind)).toEqual(["triage"]);
			expect(conflict.cards).toHaveLength(1);
			const payload = conflict.cards[0].payload as Record<string, unknown>;
			expect(payload).toMatchObject({
				amountMinor: 999,
				currency: "USD",
				cycle: "monthly",
				cancelLink: null,
				modelFields: ["cycle"],
				modelDisagrees: ["amount"],
				reason: "subscription_check_amount",
			});
			expect(payload.nextRenewalOn).not.toBe("2026-02-30");
			expect(JSON.stringify(payload)).not.toContain("evil.test");

			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${conflict.message.id}`);
			const block = subscriptionBlock(page);
			await expect(block.locator("[data-subscription-check-amount]")).toHaveText("Check the amount before tracking");
			await expect(block.locator("[data-subscription-cancel-link]")).toHaveText("No cancel link");
			await expect(block.locator("[data-subscription-price]")).toContainText("$9.99");

			const invalid = await deliver(account, incompleteReceipt(uniqueVendor("Invalidly"), "finance-invalid-extension"));
			expect(invalid.job.status).toBe("completed");
			// Only the core fields decide whether the answer is valid, so no repair request follows.
			expect(requestsFor(invalid.message.id).map((request) => request.kind)).toEqual(["triage"]);
			expect(invalid.cards).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 16: the external opt-in and the spend cap hold for the extension, and Activity says why", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fmg");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
			const external = await deliver(account, incompleteReceipt(uniqueVendor("Optoutly"), "finance-receipt"));
			expect(external.job).toMatchObject({ status: "completed", reason: "external_provider_not_allowed" });
			expect(requestsFor(external.message.id)).toEqual([]);
			expect(external.cards).toEqual([]);

			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: true } }));
			await okJson(
				await account.api.put("/api/agent/settings", {
					data: { mailboxId: account.mailboxId, dailySpendCapMicros: 1 },
				}),
			);
			const capped = await deliver(account, incompleteReceipt(uniqueVendor("Cappedly"), "finance-receipt"));
			expect(capped.job).toMatchObject({ status: "completed", reason: "spend_cap" });
			expect(requestsFor(capped.message.id)).toEqual([]);
			expect(capped.cards).toEqual([]);

			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto("/kite-activity");
			await expect(page.locator(`[data-activity-skipped="${external.job.id}"]`)).toContainText(
				"Skipped: the external AI provider is not allowed to read mail automatically",
			);
			await expect(page.locator(`[data-activity-skipped="${capped.job.id}"]`)).toContainText(
				"Paused: daily spend cap reached",
			);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});
});

test.describe("Money Watch tracking", () => {
	test("case 1: Track creates the row and its invoice document, and Undo removes both and reopens the card", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("ftt");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = `Trackflix${uniqueToken("").slice(-4)}`;
			const cancelUrl = `https://${uniqueToken("cancel").toLowerCase()}.example/cancel`;
			const { message, cards } = await deliver(
				account,
				invoice(vendor, dayFromNow(20).long, { headers: { ...AUTOMATIC, "List-Unsubscribe": `<${cancelUrl}>` } }),
			);
			expect(cards).toHaveLength(1);
			const before = await listSubscriptions(account);
			expect(before.subscriptions).toEqual([]);

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${message.id}`);
			const block = subscriptionBlock(page);
			const accepted = page.waitForResponse(
				(response) => response.url().includes(`/api/agent/suggestions/${cards[0].id}/accept`) && response.ok(),
			);
			await block.getByRole("button", { name: "Track", exact: true }).click();
			const { actionId } = (await (await accepted).json()) as { actionId: string };
			expect(actionId).toMatch(/^aact_/);
			await expect(page.getByText("Tracking the subscription")).toBeVisible();
			await expect(block).toHaveCount(0);

			const { subscriptions, totals } = await listSubscriptions(account);
			expect(subscriptions).toHaveLength(1);
			const [row] = subscriptions;
			expect(row).toMatchObject({
				vendor,
				amount: { minor: 1799, currency: "USD" },
				cycle: "monthly",
				status: "active",
				nextRenewalOn: expect.any(String),
				reminderDays: 3,
				calendarReminder: true,
				cancelUrl,
				urgent: false,
			});
			expect(totals).toMatchObject([{ currency: "USD", monthlyMinor: 1799, paidLast12MonthsMinor: 1799 }]);
			await page.goto("/finance");
			const listed = page.locator(`[data-finance-section="upcoming"] [data-finance-row="${row.id}"]`);
			await expect(listed).toContainText(vendor);
			await expect(listed).toContainText("$17.99/month");
			await expect(page.locator('[data-finance-paid="USD"]')).toHaveText("$17.99");
			const detail = await subscriptionDetail(account, row.id);
			expect(detail.documents).toMatchObject([{ docType: "invoice", messageId: message.id }]);
			const [card] = (await readSuggestions(account.api, { messageId: message.id, status: "all" })).suggestions;
			expect(card.status).toBe("accepted");

			const again = await acceptCard(account, cards[0].id, "track");
			expect(again.actionId).toBe(actionId);
			expect((await listSubscriptions(account)).subscriptions).toHaveLength(1);

			const tracked = (await activity(account)).find((item) => item.id === actionId);
			expect(tracked).toMatchObject({ action: "create_subscription", variant: "" });
			expect(tracked?.target?.href).toBe(`/finance?subscription=${row.id}`);
			await page.goto("/kite-activity");
			const activityRow = page.locator(`[data-activity-action="${actionId}"]`);
			await expect(activityRow).toContainText("Started tracking a subscription");
			await expect(activityRow).toContainText(`${vendor} · $17.99/month`);

			await page.goto(`/inbox/${message.id}`);
			await undo(account, actionId);
			expect((await listSubscriptions(account)).subscriptions).toEqual([]);
			expect((await listSubscriptions(account)).totals).toEqual([]);
			expect((await account.api.get(`/api/finance/subscriptions/${row.id}`)).status()).toBe(404);
			const [reopened] = (await readSuggestions(account.api, { messageId: message.id, status: "all" })).suggestions;
			expect(reopened.status).toBe("open");
			await page.reload();
			await expect(subscriptionBlock(page).getByRole("button", { name: "Track", exact: true })).toBeVisible();
			const undone = (await activity(account)).find((item) => item.undoOf === actionId);
			expect(undone).toBeDefined();
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 2: a second invoice updates the price, a refund lowers the 12-month total, and undo restores both", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("ftp");
		const outsider = await plainAccount("ftx");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = `Priceflix${uniqueToken("").slice(-4)}`;
			const first = await deliver(account, invoice(vendor, dayFromNow(10).long));
			const tracked = await acceptCard(account, first.cards[0].id, "track");
			const subscriptionId = tracked.subscription.id;

			const renews = dayFromNow(40);
			const pdf = `invoice-${uniqueToken("pdf")}.pdf`;
			const second = await deliver(
				account,
				invoice(vendor, renews.long, {
					text: `Invoice INV-1002\nPlan: Premium $19.99/month, renews on ${renews.long}.\n`,
					attachments: [{ filename: pdf, contentType: "application/pdf", content: Buffer.from("%PDF-1.4 invoice") }],
				}),
			);
			expect(second.cards).toHaveLength(1);
			expect(second.cards[0]).toMatchObject({
				title: `${vendor} now $19.99/month, up from $17.99. Update it?`,
				payload: { event: "price_change", previousAmountMinor: 1799, reason: "subscription_price_change" },
			});
			const updated = await acceptCard(account, second.cards[0].id, "track");
			expect(updated.subscription.id).toBe(subscriptionId);
			const { subscriptions } = await listSubscriptions(account);
			expect(subscriptions).toHaveLength(1);
			expect(subscriptions[0]).toMatchObject({
				amount: { minor: 1999, currency: "USD" },
				previousAmountMinor: 1799,
				priceChangedAt: expect.any(String),
			});
			const documents = (await subscriptionDetail(account, subscriptionId)).documents;
			expect(documents.map((document) => document.docType)).toEqual(["invoice", "invoice"]);
			expect(documents.find((document) => document.messageId === second.message.id)?.attachmentId).toBeTruthy();
			expect((await activity(account)).find((item) => item.id === updated.actionId)).toMatchObject({
				action: "create_subscription",
				variant: "update",
			});
			expect(await paidTotal(account)).toBe(3798);

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto("/finance");
			const listed = page.locator(`[data-finance-row="${subscriptionId}"]`);
			await expect(listed.locator("[data-finance-price-chip]")).toHaveText("Increased from $17.99");
			await expect(page.locator('[data-finance-paid="USD"]')).toHaveText("$37.98");
			await listed.getByRole("button", { name: new RegExp(`^${vendor}`) }).click();
			await expect(page).toHaveURL(new RegExp(`/finance\\?subscription=${subscriptionId}$`));
			const drawer = page.locator("[data-finance-drawer]");
			await expect(drawer.locator("[data-finance-drawer-paid]")).toHaveText("$37.98");
			const entries = drawer.locator("[data-finance-document]");
			await expect(entries).toHaveCount(2);
			const latest = entries.filter({ hasText: "$19.99" });
			await expect(latest).toContainText("Invoice");
			const openDocument = latest.getByRole("link", { name: "Open document" });
			const href = await openDocument.getAttribute("href");
			expect(href).toMatch(new RegExp(`^/api/messages/${second.message.id}/attachments/[^/?]+\\?preview=1$`));
			const file = await account.api.get(href!);
			expect(file.status()).toBe(200);
			expect(file.headers()["content-type"]).toContain("application/pdf");
			expect((await outsider.api.get(href!)).status()).toBe(404);
			await expect(latest.getByRole("link", { name: "Open thread" })).toHaveAttribute(
				"href",
				`/inbox/${second.message.id}`,
			);
			const earlier = entries.filter({ hasText: "$17.99" });
			await expect(earlier.getByRole("link", { name: "Open thread" })).toBeVisible();
			await expect(earlier.getByRole("link", { name: "Open document" })).toHaveCount(0);

			const refund = await deliver(account, {
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject: `Your ${vendor} refund ${uniqueToken("ref")}`,
				text: "Your refund of $19.99 has been issued to your card.",
				headers: AUTOMATIC,
			});
			expect(refund.cards).toHaveLength(1);
			expect(refund.cards[0]).toMatchObject({
				title: `${vendor} refunded $19.99. Record it?`,
				payload: { event: "refund", reason: "subscription_refund" },
			});
			const beforeRefund = (await listSubscriptions(account)).subscriptions[0];
			const recorded = await acceptCard(account, refund.cards[0].id, "record");
			expect(await paidTotal(account)).toBe(1799);
			const afterRefund = (await listSubscriptions(account)).subscriptions[0];
			for (const key of ["amount", "nextRenewalOn", "status", "lastMessageId"] as const)
				expect(afterRefund[key]).toEqual(beforeRefund[key]);
			await page.reload();
			await expect(drawer.locator("[data-finance-drawer-paid]")).toHaveText("$17.99");
			await expect(entries).toHaveCount(3);
			await expect(entries.filter({ hasText: "Refund" })).toContainText("−$19.99");
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
			await undo(account, recorded.actionId);
			expect(await paidTotal(account)).toBe(3798);

			await undo(account, updated.actionId);
			const restored = (await listSubscriptions(account)).subscriptions[0];
			expect(restored).toMatchObject({ amount: { minor: 1799 }, previousAmountMinor: null, priceChangedAt: null });
			expect((await subscriptionDetail(account, subscriptionId)).documents).toMatchObject([
				{ docType: "invoice", messageId: first.message.id },
			]);
		} finally {
			await context.close();
			await outsider.api.dispose();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 3: a failed payment is urgent only after Mark urgent, and undo clears it", async ({ browser }) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("ftf");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = `Failflix${uniqueToken("").slice(-4)}`;
			const first = await deliver(account, invoice(vendor, dayFromNow(12).long));
			await acceptCard(account, first.cards[0].id, "track");
			const failed = await deliver(account, {
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject: `Action needed ${uniqueToken("fail")}`,
				text: "Your payment failed. Please update your payment method.",
				headers: AUTOMATIC,
			});
			expect(failed.cards).toHaveLength(1);
			expect(failed.cards[0]).toMatchObject({
				title: `${vendor} payment failed. Mark it urgent?`,
				payload: { event: "payment_failed" },
			});
			expect((await listSubscriptions(account)).subscriptions[0].urgent).toBe(false);

			const page = await context.newPage();
			await selectMailbox(page, account.mailboxId);
			await page.goto(`/inbox/${failed.message.id}`);
			const accepted = page.waitForResponse(
				(response) => response.url().includes(`/api/agent/suggestions/${failed.cards[0].id}/accept`) && response.ok(),
			);
			await subscriptionBlock(page).getByRole("button", { name: "Mark urgent" }).click();
			const { actionId } = (await (await accepted).json()) as { actionId: string };
			await expect(page.getByText("Marked urgent")).toBeVisible();
			const urgent = (await listSubscriptions(account)).subscriptions[0];
			expect(urgent.urgent).toBe(true);
			const documents = (await subscriptionDetail(account, urgent.id)).documents;
			expect(documents.map((document) => document.docType).sort()).toEqual(["failed_payment", "invoice"]);
			expect(await paidTotal(account)).toBe(1799);
			expect(await okJson(await account.api.get("/api/finance/badge"))).toEqual({ count: 1 });
			await page.goto("/finance");
			const attention = page.locator('[data-finance-section="attention"]');
			await expect(attention.locator(`[data-finance-row="${urgent.id}"]`)).toContainText("Payment failed");
			await expect(page.locator(`[data-finance-section="upcoming"] [data-finance-row="${urgent.id}"]`)).toHaveCount(0);

			await undo(account, actionId);
			expect((await listSubscriptions(account)).subscriptions[0].urgent).toBe(false);
			expect((await subscriptionDetail(account, urgent.id)).documents.map((document) => document.docType)).toEqual([
				"invoice",
			]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});

	test("case 9: only the mailbox reviewer sees and decides subscription cards", async () => {
		const restore = await useFakeProvider(api, fake);
		const local = `fts${uniqueToken("")}`;
		const sharedId = await createSharedMailbox(api, local);
		const reviewerAccount = await createSignedInAccount(api, `ftr${uniqueToken("")}`);
		const reviewer: Account = { ...reviewerAccount, mailboxId: sharedId, address: `${local}@${DOMAIN}` };
		const other = await createSignedInAccount(api, `fto${uniqueToken("")}`);
		try {
			await shareMailbox(api, sharedId, reviewer.id, "full_access");
			await shareMailbox(api, sharedId, other.id, "full_access");
			await okJson(
				await api.put("/api/agent/settings", {
					data: { mailboxId: sharedId, reviewerUserId: reviewer.id, autonomy: "suggest" },
				}),
			);
			const { message, cards } = await deliver(
				reviewer,
				invoice(`Reviewflix${uniqueToken("").slice(-4)}`, dayFromNow(9).long),
			);
			expect(cards).toHaveLength(1);

			const seen = await readSuggestions(other.api, { mailboxId: reviewer.mailboxId });
			expect(seen.suggestions.filter((item) => item.kind === "subscription")).toEqual([]);
			const { messages } = await okJson<{ messages: { id: string; agentSuggestions?: unknown }[] }>(
				await other.api.get(`/api/messages?mailboxId=${reviewer.mailboxId}`),
			);
			expect(messages.find((item) => item.id === message.id)?.agentSuggestions).toBeUndefined();
			const refused = await other.api.post(`/api/agent/suggestions/${cards[0].id}/accept`, {
				data: { option: "track" },
			});
			expect(refused.status()).toBe(404);

			const accepted = await acceptCard(reviewer, cards[0].id, "track");
			expect((await subscriptionDetail(reviewer, accepted.subscription.id)).subscription.id).toBe(
				accepted.subscription.id,
			);
			expect((await other.api.get(`/api/finance/subscriptions/${accepted.subscription.id}`)).status()).toBe(404);
			expect(
				(await okJson<{ subscriptions: unknown[] }>(await other.api.get("/api/finance/subscriptions"))).subscriptions,
			).toEqual([]);
		} finally {
			await other.api.dispose();
			await reviewer.api.dispose();
			await restore();
		}
	});
});

type DetectAnswer = {
	messageId: string;
	mailboxId: string;
	draft: {
		vendor: string;
		amountMinor: number | null;
		currency: string | null;
		cycle: string | null;
		nextRenewalOn: string | null;
		cancelLink: { url: string; oneClick: boolean } | null;
		document: { docType: string; attachmentId: string | null } | null;
		subscriptionId: string | null;
	};
	attachments: { id: string; filename: string }[];
};

/** Delivers mail to an account whose automatic reading may be off, so no triage job is awaited. */
async function deliverPlain(account: { api: APIRequestContext; address: string }, mail: Omit<InboundMail, "to">) {
	await postInbound(account.api, { ...mail, to: account.address });
	return waitForMessage(account.api, mail.subject, { status: "received" });
}

async function plainAccount(prefix: string) {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	return { ...account, address: `${username}@${DOMAIN}` };
}

/** Opens the reader's overflow menu on the message and chooses the module entry. */
async function openMessageMenuItem(page: Page, messageId: string, label: string) {
	await page.goto(`/inbox/${messageId}`);
	return chooseMessageMenuItem(page, label);
}

/** Chooses the module entry from the overflow menu of the message already open in the reader. */
async function chooseMessageMenuItem(page: Page, label: string) {
	await page.getByRole("button", { name: "More actions" }).first().click();
	const detected = page.waitForResponse((response) => response.url().endsWith("/api/finance/detect"));
	await page.getByRole("button", { name: label, exact: true }).click();
	const response = await detected;
	expect(response.status()).toBe(200);
	return (await response.json()) as DetectAnswer;
}

const pdf = (name: string) => ({
	filename: name,
	contentType: "application/pdf",
	content: Buffer.from("%PDF-1.4 doc"),
});

test.describe("Money Watch manual add", () => {
	test("case 4: by hand, Track as subscription and Add to a tracked subscription, all undoable", async ({
		browser,
	}) => {
		const account = await plainAccount("fma");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const added = await okJson<{ subscription: SubscriptionView; actionId: string }>(
				await account.api.post("/api/finance/subscriptions", {
					data: {
						vendor: "Gym Plus",
						plan: "Gold",
						amountMinor: 2500,
						currency: "EUR",
						cycle: "monthly",
						nextRenewalOn: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
						reminderDays: 7,
						calendarReminder: false,
						mailboxId: account.mailboxId,
					},
				}),
			);
			expect(added.subscription).toMatchObject({
				vendor: "Gym Plus",
				amount: { minor: 2500, currency: "EUR" },
				reminderDays: 7,
				calendarReminder: false,
				cancelUrl: null,
			});
			expect((await activity(account)).find((item) => item.id === added.actionId)).toMatchObject({
				action: "create_subscription",
				variant: "",
			});
			const outOfBounds = await account.api.post("/api/finance/subscriptions", {
				data: { vendor: "Gym Plus", amountMinor: 0, currency: "EUR", mailboxId: account.mailboxId },
			});
			expect(outOfBounds.status()).toBe(400);
			await undo(account, added.actionId);
			expect((await listSubscriptions(account)).subscriptions).toEqual([]);

			const vendor = `Handflix${uniqueToken("").slice(-4)}`;
			const domain = `${vendor.toLowerCase()}.test`;
			const cancelUrl = `https://${uniqueToken("cancel").toLowerCase()}.example/cancel`;
			const invoicePdf = `invoice-${uniqueToken("pdf")}.pdf`;
			const message = await deliverPlain(
				account,
				invoice(vendor, dayFromNow(20).long, {
					headers: { ...AUTOMATIC, "List-Unsubscribe": `<${cancelUrl}>` },
					attachments: [pdf(invoicePdf)],
				}),
			);

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			const draft = await openMessageMenuItem(page, message.id, "Track as subscription");
			expect(draft.draft).toMatchObject({
				vendor,
				amountMinor: 1799,
				currency: "USD",
				cycle: "monthly",
				cancelLink: { url: cancelUrl },
				document: { docType: "invoice" },
				subscriptionId: null,
			});
			const dialog = page.locator("[data-finance-track-dialog]");
			await expect(dialog.getByLabel("Vendor")).toHaveValue(vendor);
			await expect(dialog.getByLabel("Amount", { exact: true }).first()).toHaveValue("17.99");
			await expect(dialog.locator("[data-finance-cancel-link]")).toContainText(new URL(cancelUrl).host);
			await expect(dialog.getByLabel("Attachment")).toContainText(invoicePdf);
			expect((await listSubscriptions(account)).subscriptions).toEqual([]);
			const saved = page.waitForResponse(
				(response) => response.url().endsWith("/api/finance/subscriptions") && response.request().method() === "POST",
			);
			await dialog.getByRole("button", { name: "Track subscription" }).click();
			expect((await saved).status()).toBe(200);
			await expect(page.getByText("Tracking the subscription")).toBeVisible();
			await expect(dialog).toHaveCount(0);
			const [row] = (await listSubscriptions(account)).subscriptions;
			expect(row).toMatchObject({ vendor, cancelUrl, amount: { minor: 1799, currency: "USD" } });
			expect((await subscriptionDetail(account, row.id)).documents).toMatchObject([
				{ docType: "invoice", messageId: message.id, attachmentId: expect.any(String) },
			]);

			const receiptPdf = `receipt-${uniqueToken("pdf")}.pdf`;
			const receipt = await deliverPlain(account, {
				from: `${vendor} Billing <billing@${domain}>`,
				subject: `Your ${vendor} payment receipt ${uniqueToken("rcpt")}`,
				text: "Payment received, thank you for your payment.\nPlan: Premium $17.99/month.\n",
				headers: AUTOMATIC,
				attachments: [pdf(receiptPdf)],
			});
			const other = await deliverPlain(account, {
				from: `Someone <someone@${domain}>`,
				subject: `Unrelated ${uniqueToken("other")}`,
				text: "Hello",
				attachments: [pdf(`other-${uniqueToken("pdf")}.pdf`)],
			});
			const documentDraft = await openMessageMenuItem(page, receipt.id, "Add to a tracked subscription");
			expect(documentDraft.draft.subscriptionId).toBe(row.id);
			const documentDialog = page.locator("[data-finance-document-dialog]");
			await expect(documentDialog.getByLabel("Subscription")).toHaveValue(row.id);
			await expect(documentDialog.getByLabel("Attachment")).toContainText(receiptPdf);
			await documentDialog.getByLabel("Document").selectOption("payment");
			await documentDialog.getByLabel("Amount").fill("17.99");
			await documentDialog.getByLabel("Currency").fill("USD");
			const attachmentId = documentDraft.attachments[0].id;
			await documentDialog.getByLabel("Attachment").selectOption(attachmentId);
			const recordedResponse = page.waitForResponse((response) =>
				response.url().endsWith(`/api/finance/subscriptions/${row.id}/documents`),
			);
			await documentDialog.getByRole("button", { name: "Record document" }).click();
			const recorded = await recordedResponse;
			expect(recorded.status()).toBe(200);
			const { document, actionId } = (await recorded.json()) as {
				document: DocumentView & { documentOn: string };
				actionId: string;
			};
			expect(document).toMatchObject({ docType: "payment", messageId: receipt.id, attachmentId });
			expect((await activity(account)).find((item) => item.id === actionId)).toMatchObject({
				action: "record_document",
				variant: "payment",
			});
			await expect(documentDialog).toHaveCount(0);

			await openMessageMenuItem(page, receipt.id, "Add to a tracked subscription");
			await documentDialog.getByLabel("Document").selectOption("payment");
			await documentDialog.getByLabel("Amount").fill("17.99");
			await documentDialog.getByLabel("Currency").fill("USD");
			await documentDialog.getByRole("button", { name: "Record document" }).click();
			await expect(documentDialog.getByRole("alert")).toHaveText(
				"This document is already recorded for the subscription",
			);
			await page.keyboard.press("Escape");

			const body = {
				messageId: receipt.id,
				docType: "refund",
				amountMinor: 100,
				currency: "USD",
				documentOn: document.documentOn,
			};
			const duplicate = await account.api.post(`/api/finance/subscriptions/${row.id}/documents`, {
				data: { ...body, docType: "payment", amountMinor: 1799 },
			});
			expect(duplicate.status()).toBe(409);
			expect(await duplicate.json()).toMatchObject({ code: "DOCUMENT_EXISTS" });
			const otherAttachment = (
				await okJson<{ attachments: { id: string }[] }>(await account.api.get(`/api/messages/${other.id}`))
			).attachments[0].id;
			const foreign = await account.api.post(`/api/finance/subscriptions/${row.id}/documents`, {
				data: { ...body, attachmentId: otherAttachment },
			});
			expect(foreign.status()).toBe(404);

			await undo(account, actionId);
			expect((await subscriptionDetail(account, row.id)).documents.map((item) => item.docType)).toEqual(["invoice"]);
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("case 4: reopening Add to a tracked subscription preselects a row tracked since it was last open", async ({
		browser,
	}) => {
		const account = await plainAccount("fmr");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = `Reopenflix${uniqueToken("").slice(-4)}`;
			const message = await deliverPlain(account, invoice(vendor, dayFromNow(20).long, { headers: AUTOMATIC }));
			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			const documentDialog = page.locator("[data-finance-document-dialog]");
			await openMessageMenuItem(page, message.id, "Add to a tracked subscription");
			await expect(documentDialog).toContainText("You are not tracking any subscriptions yet.");
			await page.keyboard.press("Escape");
			await expect(documentDialog).toHaveCount(0);

			await chooseMessageMenuItem(page, "Track as subscription");
			const trackDialog = page.locator("[data-finance-track-dialog]");
			await expect(trackDialog.getByLabel("Vendor")).toHaveValue(vendor);
			await trackDialog.getByRole("button", { name: "Track subscription" }).click();
			await expect(trackDialog).toHaveCount(0);
			const [row] = (await listSubscriptions(account)).subscriptions;
			expect(row).toMatchObject({ vendor });

			// Hold the list until the detector answers, the order in which a cached list would mount the form.
			let detected!: () => void;
			const detectAnswered = new Promise<void>((resolve) => (detected = resolve));
			await page.route(
				(url) => url.pathname === "/api/finance/subscriptions",
				async (route) => {
					await detectAnswered;
					await route.continue();
				},
			);
			const draft = await chooseMessageMenuItem(page, "Add to a tracked subscription");
			detected();
			expect(draft.draft.subscriptionId).toBe(row.id);
			await expect(documentDialog.getByLabel("Subscription")).toHaveValue(row.id);
			await expect(documentDialog.getByRole("button", { name: "Record document" })).toBeEnabled();
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("case 4: a subscription tracked from a message is updated by the vendor's next invoice card", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fmn");
		try {
			const vendor = `Nextflix${uniqueToken("").slice(-4)}`;
			const first = await deliver(account, invoice(vendor, dayFromNow(15).long));
			const { draft } = await okJson<DetectAnswer>(
				await account.api.post("/api/finance/detect", { data: { messageId: first.message.id } }),
			);
			const tracked = await okJson<{ subscription: SubscriptionView & { vendorKey: string } }>(
				await account.api.post("/api/finance/subscriptions", {
					data: {
						vendor: draft.vendor,
						amountMinor: draft.amountMinor,
						currency: draft.currency,
						cycle: draft.cycle,
						nextRenewalOn: draft.nextRenewalOn,
						messageId: first.message.id,
						document: { ...draft.document, amountMinor: draft.amountMinor, currency: draft.currency },
					},
				}),
			);
			expect(tracked.subscription.vendorKey).toBe(`${vendor.toLowerCase()}.test`);

			const second = await deliver(account, invoice(vendor, dayFromNow(45).long));
			expect(second.cards).toHaveLength(1);
			expect(["renewal", "price_change"]).toContain(second.cards[0].payload.event);
			expect(second.cards[0].payload.subscriptionId).toBe(tracked.subscription.id);
			await acceptCard(account, second.cards[0].id, "track");
			const { subscriptions } = await listSubscriptions(account);
			expect(subscriptions.map((item) => item.id)).toEqual([tracked.subscription.id]);
			expect(
				(await subscriptionDetail(account, tracked.subscription.id)).documents.map((item) => item.docType),
			).toEqual(["invoice", "invoice"]);
		} finally {
			await account.api.dispose();
			await restore();
		}
	});

	test("the Subscriptions sidebar item shows the badge count and is gone while Money Watch is off for the user", async ({
		browser,
	}) => {
		const account = await plainAccount("fsb");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
		try {
			for (const [vendor, nextRenewalOn] of [
				["Soonflix", day(1)],
				["Laterflix", day(20)],
			])
				await okJson(
					await account.api.post("/api/finance/subscriptions", {
						data: {
							vendor,
							amountMinor: 999,
							currency: "USD",
							cycle: "monthly",
							nextRenewalOn,
							reminderDays: 3,
							calendarReminder: false,
							mailboxId: account.mailboxId,
						},
					}),
				);
			expect(await okJson(await account.api.get("/api/finance/badge"))).toEqual({ count: 1 });

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto("/inbox");
			const nav = page.getByRole("navigation").first();
			const item = nav.locator('a[href="/finance"]');
			await expect(item).toContainText("Subscriptions");
			await expect(item).toContainText("1");
			const hrefs = await nav.locator("a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
			const inbox = hrefs.lastIndexOf("/inbox");
			expect(hrefs.slice(inbox + 1, inbox + 3).filter((href) => href !== "/for-you")[0]).toBe("/finance");
			await item.click();
			await expect(page).toHaveURL(/\/finance$/);

			await setModuleState(api, { access: [{ userId: account.id, moduleId: "finance", allowed: false }] });
			expect((await account.api.get("/api/finance/badge")).status()).toBe(404);
			await page.goto("/inbox");
			await expect(nav.locator('a[href="/inbox"]').last()).toBeVisible();
			await expect(item).toHaveCount(0);
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await restoreModules(api, [account.id]);
			await context.close();
			await account.api.dispose();
		}
	});

	test("signed-out callers get 401 from every Money Watch route", async () => {
		const anonymous = await apiContext();
		try {
			for (const [method, path] of [
				["GET", "/api/finance/subscriptions"],
				["POST", "/api/finance/subscriptions"],
				["GET", "/api/finance/subscriptions/e2e_probe"],
				["PATCH", "/api/finance/subscriptions/e2e_probe"],
				["DELETE", "/api/finance/subscriptions/e2e_probe"],
				["POST", "/api/finance/subscriptions/e2e_probe/documents"],
				["DELETE", "/api/finance/documents/e2e_probe"],
				["POST", "/api/finance/detect"],
				["GET", "/api/finance/badge"],
			] as const) {
				// No body: the dev server's proxy can drop the next keep-alive request after a 401 that left a body unread.
				const response = await anonymous.fetch(path, { method });
				expect(response.status(), `${method} ${path}`).toBe(401);
			}
		} finally {
			await anonymous.dispose();
		}
	});
});

type CalendarEventRow = { id: string; title: string; icalUid: string | null; startsAt: string; endsAt: string };
type NoticeFrame = { type: string; moduleId: string; notice: string; title: string; href: string | null };

const isoDay = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Records every realtime frame the page receives, as e2e/26 records its sockets. */
function recordRealtimeFrames() {
	const frames: string[] = [];
	(window as { __kiteFrames?: string[] }).__kiteFrames = frames;
	const sockets: WebSocket[] = [];
	(window as { __kiteSockets?: WebSocket[] }).__kiteSockets = sockets;
	const OriginalWebSocket = window.WebSocket;
	const RecordingWebSocket = class extends OriginalWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			if (String(url).includes("/api/realtime")) {
				sockets.push(this as unknown as WebSocket);
				this.addEventListener("message", (event) => frames.push(String(event.data)));
			}
		}
	};
	Object.defineProperty(window, "WebSocket", { value: RecordingWebSocket, configurable: true });
}

/** Opens the inbox with a live realtime socket for the account, recording its frames. */
async function openRealtimePage(browser: Browser, account: { id: string; api: APIRequestContext; mailboxId: string }) {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
	const page = await context.newPage();
	await page.addInitScript((userId) => localStorage.setItem("kite-session-user", userId), account.id);
	await page.addInitScript(recordRealtimeFrames);
	await selectMailbox(page, account.mailboxId);
	await page.goto("/inbox");
	await page.waitForFunction(() =>
		((window as { __kiteSockets?: WebSocket[] }).__kiteSockets ?? []).some((socket) => socket.readyState === 1),
	);
	return { context, page };
}

async function noticeFrames(page: Page): Promise<NoticeFrame[]> {
	const frames = await page.evaluate(() => (window as { __kiteFrames?: string[] }).__kiteFrames ?? []);
	return frames
		.map((frame) => {
			try {
				return JSON.parse(frame) as NoticeFrame;
			} catch {
				return null;
			}
		})
		.filter((frame): frame is NoticeFrame => frame?.type === "module_notice");
}

/** Runs the `*` + `/5` cron trigger once, through the Worker's real `scheduled` handler. */
async function cronTick() {
	const response = await api.get(`/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
	expect(response.ok()).toBe(true);
}

async function reminderEvents(account: { api: APIRequestContext }, subscriptionId: string) {
	const start = new Date(Date.now() - 86_400_000).toISOString();
	const end = new Date(Date.now() + 10 * 86_400_000).toISOString();
	const { events } = await okJson<{ events: CalendarEventRow[] }>(
		await account.api.get(`/api/calendar/events?start=${start}&end=${end}`),
	);
	return events.filter((event) => event.icalUid === `finance-renewal:${subscriptionId}`);
}

async function trackRenewing(account: { api: APIRequestContext; mailboxId: string }, vendor: string) {
	const { subscription } = await okJson<{ subscription: SubscriptionView }>(
		await account.api.post("/api/finance/subscriptions", {
			data: {
				vendor,
				amountMinor: 1799,
				currency: "USD",
				cycle: "monthly",
				nextRenewalOn: isoDay(2),
				reminderDays: 3,
				calendarReminder: true,
				mailboxId: account.mailboxId,
			},
		}),
	);
	return subscription;
}

test.describe("Money Watch reminders", () => {
	test("case 5: one cron tick sends one renewal notice, a badge of 1 and one calendar event; a second tick adds nothing", async ({
		browser,
	}) => {
		const account = await plainAccount("frn");
		const { context, page } = await openRealtimePage(browser, account);
		try {
			const errors = collectConsoleErrors(page);
			const vendor = uniqueVendor("Remindflix");
			const row = await trackRenewing(account, vendor);
			const nav = page.getByRole("navigation").first().locator('a[href="/finance"]');

			await cronTick();
			await expect.poll(async () => (await noticeFrames(page)).length, { timeout: 20_000 }).toBe(1);
			const [frame] = await noticeFrames(page);
			expect(frame).toMatchObject({
				moduleId: "finance",
				notice: "renewal_due",
				title: `${vendor} renews in 2 days ($17.99)`,
				href: `/finance?subscription=${row.id}`,
			});
			const toast = page.getByRole("status").filter({ hasText: `${vendor} renews in 2 days` });
			await expect(toast).toBeVisible();
			expect(await okJson(await account.api.get("/api/finance/badge"))).toEqual({ count: 1 });
			await expect(nav).toContainText("1");

			const [event, ...others] = await reminderEvents(account, row.id);
			expect(others).toEqual([]);
			expect(event.title).toBe(`${vendor} renews ($17.99)`);
			expect(new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()).toBe(15 * 60_000);

			await cronTick();
			await page.waitForTimeout(3_000);
			expect(await noticeFrames(page)).toHaveLength(1);
			expect((await reminderEvents(account, row.id)).map((item) => item.id)).toEqual([event.id]);

			await toast.getByRole("link", { name: "Open" }).click();
			await expect(page).toHaveURL(new RegExp(`/finance\\?subscription=${row.id}$`));

			await okJson(
				await account.api.patch(`/api/finance/subscriptions/${row.id}`, {
					data: { fields: { nextRenewalOn: isoDay(4) } },
				}),
			);
			const [moved] = await reminderEvents(account, row.id);
			expect(moved.id).toBe(event.id);
			expect(new Date(moved.startsAt).getTime() - new Date(event.startsAt).getTime()).toBe(2 * 86_400_000);
			await okJson(await account.api.patch(`/api/finance/subscriptions/${row.id}`, { data: { status: "cancelled" } }));
			expect(await reminderEvents(account, row.id)).toEqual([]);
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("case 6: with Calendar off for the user the reminder still notifies, creates no event and the row keeps working", async ({
		browser,
	}) => {
		const account = await plainAccount("frc");
		const { context, page } = await openRealtimePage(browser, account);
		try {
			await setModuleState(api, { access: [{ userId: account.id, moduleId: "calendar", allowed: false }] });
			const vendor = uniqueVendor("Offcalflix");
			const row = await trackRenewing(account, vendor);

			await cronTick();
			await expect.poll(async () => (await noticeFrames(page)).length, { timeout: 20_000 }).toBe(1);
			expect((await noticeFrames(page))[0]).toMatchObject({
				notice: "renewal_due",
				title: `${vendor} renews in 2 days ($17.99)`,
			});
			await expect(page.getByRole("status").filter({ hasText: `${vendor} renews in 2 days` })).toBeVisible();
			expect(await okJson(await account.api.get("/api/finance/badge"))).toEqual({ count: 1 });

			const edited = await okJson<{ subscription: SubscriptionView }>(
				await account.api.patch(`/api/finance/subscriptions/${row.id}`, { data: { fields: { plan: "Family" } } }),
			);
			expect(edited.subscription.vendor).toBe(vendor);

			await restoreModules(api, [account.id]);
			expect(await reminderEvents(account, row.id)).toEqual([]);
		} finally {
			await restoreModules(api, [account.id]);
			await context.close();
			await account.api.dispose();
		}
	});
});

type ViewTotals = (Totals[number] & { yearlyMinor: number; trialMonthlyMinor: number })[];
type HandRow = {
	vendor: string;
	amountMinor?: number | null;
	currency?: string | null;
	cycle?: string | null;
	nextRenewalOn?: string | null;
	trialEndsOn?: string | null;
	status?: string;
	reminderDays?: number;
	messageId?: string;
	document?: { docType: string; amountMinor: number; currency: string; documentOn: string };
};

async function addByHand(account: { api: APIRequestContext; mailboxId: string }, row: HandRow) {
	const { subscription } = await okJson<{ subscription: SubscriptionView }>(
		await account.api.post("/api/finance/subscriptions", {
			data: { reminderDays: 0, calendarReminder: false, mailboxId: account.mailboxId, ...row },
		}),
	);
	return subscription;
}

const financeRow = (page: Page, id: string) => page.locator(`[data-finance-row="${id}"]`);
const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

async function openRowMenu(page: Page, vendor: string) {
	await page.getByRole("button", { name: `More actions for ${vendor}` }).click();
	const menu = page.locator("[data-finance-row-menu]");
	await expect(menu).toBeVisible();
	return menu;
}

async function chooseReminder(page: Page, vendor: string, label: string) {
	const menu = await openRowMenu(page, vendor);
	// The keyboard opens the submenu without a pointer path across the other items, which would close it.
	await menu.getByRole("menuitem", { name: "Reminder" }).press("ArrowRight");
	const reminders = page.locator("[data-finance-reminder-menu]");
	await expect(reminders).toBeVisible();
	return reminders.getByRole("menuitemcheckbox", { name: label, exact: true });
}

/** Fails when the element (or the page) is wider than its box, which is what horizontal overflow looks like. */
async function expectNoOverflow(page: Page, selector: string | null, name: string) {
	const sizes = await page.evaluate((target) => {
		const element = target ? document.querySelector(target) : document.documentElement;
		return element ? { scroll: element.scrollWidth, client: element.clientWidth } : null;
	}, selector);
	expect(sizes, name).not.toBeNull();
	expect(sizes!.scroll, name).toBeLessThanOrEqual(sizes!.client + 1);
}

test.describe("Money Watch view", () => {
	test.use({ timezoneId: "UTC" });

	test("case 7: the view lists rows in due order with totals, edits a reminder and cancels through the header link", async ({
		browser,
	}) => {
		const account = await plainAccount("fvw");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = uniqueVendor("Viewflix");
			const cancelUrl = `https://${uniqueToken("cancel").toLowerCase()}.example/cancel`;
			const source = await deliverPlain(
				account,
				invoice(vendor, dayFromNow(10).long, { headers: { ...AUTOMATIC, "List-Unsubscribe": `<${cancelUrl}>` } }),
			);
			const cancellable = await addByHand(account, {
				vendor,
				amountMinor: 1799,
				currency: "USD",
				cycle: "monthly",
				nextRenewalOn: isoDay(10),
				messageId: source.id,
				document: { docType: "payment", amountMinor: 1799, currency: "USD", documentOn: isoDay(0) },
			});
			expect(cancellable.cancelUrl).toBe(cancelUrl);
			const yearlyVendor = uniqueVendor("Yearbox");
			const yearlySource = await deliverPlain(account, invoice(yearlyVendor, dayFromNow(30).long));
			const yearly = await addByHand(account, {
				vendor: yearlyVendor,
				amountMinor: 12000,
				currency: "EUR",
				cycle: "yearly",
				nextRenewalOn: isoDay(30),
				messageId: yearlySource.id,
			});
			const weekly = await addByHand(account, {
				vendor: uniqueVendor("Weekbox"),
				amountMinor: 500,
				currency: "USD",
				cycle: "weekly",
				nextRenewalOn: isoDay(3),
			});
			const undated = await addByHand(account, { vendor: uniqueVendor("Nodate") });
			const { totals } = await okJson<{ totals: ViewTotals }>(await account.api.get("/api/finance/subscriptions"));
			const dollars = totals.find((total) => total.currency === "USD")!;
			expect(dollars.monthlyMinor).toBe(Math.round(1799 + (500 * 52) / 12));
			expect(totals.find((total) => total.currency === "EUR")).toMatchObject({
				monthlyMinor: 1000,
				yearlyMinor: 12000,
			});

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			const cancelRequests: string[] = [];
			page.on("request", (request) => {
				if (request.url().startsWith(new URL(cancelUrl).origin)) cancelRequests.push(request.resourceType());
			});
			await context.route(`${new URL(cancelUrl).origin}/**`, (route) =>
				route.fulfill({ contentType: "text/html", body: "<title>Cancel</title>" }),
			);
			await page.addInitScript(() => {
				const opened: unknown[][] = [];
				(window as { __kiteOpened?: unknown[][] }).__kiteOpened = opened;
				const original = window.open.bind(window);
				window.open = (...args: Parameters<typeof window.open>) => {
					opened.push(args);
					return original(...args);
				};
			});
			await selectMailbox(page, account.mailboxId);
			await page.goto("/inbox");
			await page.getByRole("navigation").first().locator('a[href="/finance"]').click();
			await expect(page).toHaveURL(/\/finance$/);
			await expect(page.getByRole("heading", { name: "Subscriptions", level: 1 })).toBeVisible();
			await expect(page.getByRole("button", { name: "Add subscription" })).toBeVisible();
			expect(await page.getByLabel("Show").locator("option").allTextContents()).toEqual([
				"Active and trials",
				"Cancelled and expired",
				"All",
			]);

			const upcoming = page.locator('[data-finance-section="upcoming"]');
			await expect(upcoming.getByRole("heading")).toContainText("Upcoming renewals");
			expect(
				await upcoming
					.locator("[data-finance-row]")
					.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-finance-row"))),
			).toEqual([weekly.id, cancellable.id, yearly.id]);
			await expect(financeRow(page, weekly.id)).toContainText(`$5.00/week · renews in 3 days (${dayFromNow(3).short})`);
			await expect(financeRow(page, cancellable.id)).toContainText(
				`$17.99/month · renews in 10 days (${dayFromNow(10).short})`,
			);
			await expect(financeRow(page, cancellable.id).locator("[data-finance-status]")).toHaveText("Active");
			await expect(page.locator('[data-finance-section="no-date"]')).toContainText(undated.vendor);
			await expect(page.locator('[data-finance-cost="USD"]')).toContainText(
				`${usd(dollars.monthlyMinor)}/month · ${usd(dollars.yearlyMinor)}/year`,
			);
			await expect(page.locator('[data-finance-cost="EUR"]')).toContainText("€10.00/month · €120.00/year");
			await expect(page.locator("[data-finance-unpriced]")).toHaveText("1 without a price");
			await expect(page.locator('[data-finance-paid="USD"]')).toHaveText(usd(dollars.paidLast12MonthsMinor));
			expect(dollars.paidLast12MonthsMinor).toBe(1799);
			await expect(financeRow(page, yearly.id).getByRole("link", { name: "Open latest message" })).toHaveAttribute(
				"href",
				`/inbox/${yearlySource.id}`,
			);

			const patched = () =>
				page.waitForResponse(
					(response) =>
						response.url().endsWith(`/api/finance/subscriptions/${cancellable.id}`) &&
						response.request().method() === "PATCH",
				);
			let answer = patched();
			await (await chooseReminder(page, vendor, "7 days before")).press("Enter");
			expect((await answer).status()).toBe(200);
			const toast = page.getByRole("status").filter({ hasText: "Reminder set to 7 days before" });
			await expect(toast).toBeVisible();
			expect((await subscriptionDetail(account, cancellable.id)).subscription.reminderDays).toBe(7);
			expect((await activity(account)).find((item) => item.action === "update_subscription")).toMatchObject({
				variant: "reminder",
			});
			await toast.getByRole("button", { name: "Undo" }).click();
			await expect
				.poll(async () => (await subscriptionDetail(account, cancellable.id)).subscription.reminderDays)
				.toBe(0);
			await expect(await chooseReminder(page, vendor, "Off")).toHaveAttribute("aria-checked", "true");
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");
			answer = patched();
			await (await chooseReminder(page, vendor, "7 days before")).press("Enter");
			expect((await answer).status()).toBe(200);
			await page.reload();
			await expect(await chooseReminder(page, vendor, "7 days before")).toHaveAttribute("aria-checked", "true");
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");

			const row = financeRow(page, cancellable.id);
			const cancel = row.getByRole("button", { name: `Cancel before ${dayFromNow(9).short}` });
			await expect(cancel).toBeVisible();
			await expect(row).toContainText(`Opens ${new URL(cancelUrl).host}`);
			const popupOpened = context.waitForEvent("page");
			await cancel.click();
			const popup = await popupOpened;
			await popup.waitForLoadState();
			expect(popup.url()).toBe(cancelUrl);
			expect(await popup.evaluate(() => window.opener)).toBeNull();
			expect(await page.evaluate(() => (window as { __kiteOpened?: unknown[][] }).__kiteOpened)).toEqual([
				[cancelUrl, "_blank", "noopener,noreferrer"],
			]);
			expect(cancelRequests.filter((type) => type === "fetch" || type === "xhr")).toEqual([]);
			await popup.close();

			const prompt = row.locator("[data-finance-cancel-prompt]");
			await expect(prompt).toContainText("Did you cancel?");
			answer = patched();
			await prompt.getByRole("button", { name: "Mark as cancelled" }).click();
			expect((await answer).status()).toBe(200);
			await expect(page.getByRole("status").filter({ hasText: "Marked as cancelled" })).toBeVisible();
			await expect(upcoming.locator(`[data-finance-row="${cancellable.id}"]`)).toHaveCount(0);
			const ended = page.locator('[data-finance-section="ended"]');
			const toggle = ended.getByRole("button", { name: /Cancelled and expired/ });
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await toggle.click();
			await expect(ended.locator(`[data-finance-row="${cancellable.id}"] [data-finance-status]`)).toHaveText(
				"Cancelled",
			);
			expect((await subscriptionDetail(account, cancellable.id)).subscription.status).toBe("cancelled");
			expect((await activity(account)).find((item) => item.action === "set_subscription_status")).toMatchObject({
				variant: "cancelled",
			});
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("case 4: the Add dialog, the palette commands, Edit, the status changes and Remove work from /finance, all undoable", async ({
		browser,
	}) => {
		const account = await plainAccount("fva");
		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		try {
			const vendor = uniqueVendor("Dialogbox");
			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			await page.goto("/inbox");
			await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
			const search = await openPalette(page);
			await search.fill("Open Subscriptions");
			await page.getByText("Open Subscriptions", { exact: true }).click();
			await expect(page).toHaveURL(/\/finance$/);
			await expect(page.getByText("Money Watch lists the subscriptions you track here")).toBeVisible();

			const dialog = page.locator("[data-finance-subscription-dialog]");
			await page.getByRole("button", { name: "Add subscription" }).click();
			await expect(dialog.getByRole("heading", { name: "Add subscription" })).toBeVisible();
			for (const label of [
				"Vendor",
				"Plan (optional)",
				"Amount",
				"Currency",
				"Billed",
				"Next renewal",
				"Trial ends (optional)",
				"Remind days before",
				"Add a calendar reminder",
				"Mailbox",
			])
				await expect(dialog.getByLabel(label, { exact: true }), label).toBeVisible();
			await expect(dialog.getByLabel("Mailbox")).toHaveValue(account.mailboxId);
			await dialog.getByLabel("Vendor").fill(vendor);
			await dialog.getByLabel("Amount").fill("9.99");
			await dialog.getByLabel("Currency").fill("usd");
			await dialog.getByLabel("Billed").selectOption("monthly");
			await dialog.getByLabel("Next renewal").fill(isoDay(12));
			await dialog.getByLabel("Remind days before").fill("3");
			const created = page.waitForResponse(
				(response) => response.url().endsWith("/api/finance/subscriptions") && response.request().method() === "POST",
			);
			await dialog.getByRole("button", { name: "Add subscription" }).click();
			expect((await created).status()).toBe(200);
			await expect(dialog).toHaveCount(0);
			await expect(page.getByRole("status").filter({ hasText: "Subscription added" })).toBeVisible();
			const [row] = (await listSubscriptions(account)).subscriptions;
			expect(row).toMatchObject({ vendor, amount: { minor: 999, currency: "USD" }, cycle: "monthly", reminderDays: 3 });
			const listed = financeRow(page, row.id);
			await expect(listed).toContainText("$9.99/month · renews in 12 days");

			await (await openRowMenu(page, vendor)).getByRole("menuitem", { name: "Edit" }).click();
			await expect(dialog.getByRole("heading", { name: `Edit ${vendor}` })).toBeVisible();
			await expect(dialog.getByLabel("Amount")).toHaveValue("9.99");
			await dialog.getByLabel("Plan (optional)").fill("Family");
			await dialog.getByRole("button", { name: "Save changes" }).click();
			await expect(dialog).toHaveCount(0);
			const changed = page.getByRole("status").filter({ hasText: "Subscription changed" });
			await expect(changed).toBeVisible();
			await expect(listed).toContainText("Family");
			await changed.getByRole("button", { name: "Undo" }).click();
			await expect(listed).not.toContainText("Family");

			await (await openRowMenu(page, vendor)).getByRole("menuitem", { name: "Mark as expired" }).click();
			await expect(page.getByRole("status").filter({ hasText: "Marked as expired" })).toBeVisible();
			await expect(page.locator('[data-finance-section="upcoming"]')).toHaveCount(0);
			await page.getByLabel("Show").selectOption("ended");
			await expect(listed.locator("[data-finance-status]")).toHaveText("Expired");
			await (await openRowMenu(page, vendor)).getByRole("menuitem", { name: "Mark as active" }).click();
			await expect(page.getByRole("status").filter({ hasText: "Marked as active" })).toBeVisible();
			await expect(page.getByText("No cancelled or expired subscriptions.")).toBeVisible();
			await page.getByLabel("Show").selectOption("current");
			await expect(listed.locator("[data-finance-status]")).toHaveText("Active");

			await (await openRowMenu(page, vendor)).getByRole("menuitem", { name: "Remove" }).click();
			const removed = page.getByRole("status").filter({ hasText: `Removed ${vendor}` });
			await expect(removed).toBeVisible();
			await expect(listed).toHaveCount(0);
			expect((await listSubscriptions(account)).subscriptions).toEqual([]);
			await removed.getByRole("button", { name: "Undo" }).click();
			await expect(listed).toBeVisible();
			expect((await listSubscriptions(account)).subscriptions.map((item) => item.id)).toEqual([row.id]);

			const palette = await openPalette(page);
			await palette.fill("Add a subscription");
			await page.getByText("Add a subscription", { exact: true }).click();
			await expect(page).toHaveURL(/\/finance\?add=1$/);
			await expect(dialog.getByRole("heading", { name: "Add subscription" })).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(page).toHaveURL(/\/finance$/);
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("case 13: the view, the drawer, the card and the dialogs render without overflow in Kite, Classic and dark mode on a short viewport", async ({
		browser,
	}) => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("fvs");
		const context = await browser.newContext({
			baseURL: BASE_URL,
			storageState: await account.api.storageState(),
			viewport: { width: 1280, height: 600 },
		});
		try {
			const cardVendor = uniqueVendor("Cardflix");
			const { message, cards } = await deliver(account, invoice(cardVendor, dayFromNow(20).long));
			expect(cards).toHaveLength(1);
			const vendor = uniqueVendor("Stylebox");
			const source = await deliverPlain(account, {
				from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
				subject: `Your ${vendor} invoice ${uniqueToken("inv")}`,
				text: "Hello",
			});
			const tracked = await addByHand(account, {
				vendor,
				amountMinor: 1799,
				currency: "USD",
				cycle: "monthly",
				nextRenewalOn: isoDay(8),
				messageId: source.id,
				document: { docType: "invoice", amountMinor: 1799, currency: "USD", documentOn: isoDay(0) },
			});
			const trial = await addByHand(account, {
				vendor: uniqueVendor("Trialbox"),
				amountMinor: 1200,
				currency: "EUR",
				cycle: "monthly",
				status: "trial",
				trialEndsOn: isoDay(2),
				reminderDays: 3,
			});

			const page = await context.newPage();
			const errors = collectConsoleErrors(page);
			await selectMailbox(page, account.mailboxId);
			for (const style of [
				{ name: "kite", theme: "light", classic: false },
				{ name: "classic", theme: "light", classic: true },
				{ name: "dark", theme: "dark", classic: false },
			]) {
				await page.addInitScript(({ theme, classic }) => {
					localStorage.setItem("kite-theme", theme);
					if (classic) localStorage.setItem("kite-style", "classic");
					else localStorage.removeItem("kite-style");
				}, style);
				await page.goto("/finance");
				expect(
					await page.evaluate(() => ({
						classic: document.documentElement.dataset.style === "classic",
						dark: document.documentElement.classList.contains("dark"),
					})),
				).toEqual({ classic: style.classic, dark: style.theme === "dark" });
				const attention = page.locator('[data-finance-section="attention"]');
				await expect(attention.locator(`[data-finance-row="${trial.id}"]`)).toContainText("Trial ends in 2 days");
				await expect(financeRow(page, tracked.id)).toBeVisible();
				await expect(page.locator('[data-finance-paid="USD"]')).toHaveText("$17.99");
				await expectNoOverflow(page, null, `${style.name} page`);
				await expectNoOverflow(page, "[data-finance-page]", `${style.name} view`);

				await financeRow(page, tracked.id)
					.getByRole("button", { name: new RegExp(`^${vendor}`) })
					.click();
				const drawer = page.locator("[data-finance-drawer]");
				await expect(drawer.locator("[data-finance-document]")).toHaveCount(1);
				await expect(drawer.locator("[data-finance-drawer-paid]")).toHaveText("$17.99");
				await expectNoOverflow(page, "[data-finance-drawer]", `${style.name} drawer`);
				await page.keyboard.press("Escape");
				await expect(drawer).toHaveCount(0);

				await page.getByRole("button", { name: "Add subscription" }).click();
				const dialog = page.locator("[data-finance-subscription-dialog]");
				await expect(dialog).toBeVisible();
				const box = await dialog.boundingBox();
				expect(box!.height, `${style.name} dialog height`).toBeLessThanOrEqual(600 - 64 + 1);
				await expectNoOverflow(page, "[data-finance-subscription-dialog]", `${style.name} dialog`);
				const submit = dialog.getByRole("button", { name: "Add subscription" });
				await submit.scrollIntoViewIfNeeded();
				await expect(submit).toBeInViewport();
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);

				await page.goto(`/inbox/${message.id}`);
				const block = subscriptionBlock(page);
				await expect(block.getByRole("button", { name: "Track", exact: true })).toBeVisible();
				// The card's menu button sits in the card's padding, so its content is measured against the card box.
				const spill = await block.evaluate((element) => {
					const box = (element.parentElement ?? element).getBoundingClientRect();
					return Math.max(
						0,
						...[...element.querySelectorAll("*")].map((child) => {
							const rect = child.getBoundingClientRect();
							return rect.width === 0 ? 0 : Math.max(rect.right - box.right, box.left - rect.left);
						}),
					);
				});
				expect(spill, `${style.name} card`).toBeLessThanOrEqual(1);
				await expectNoOverflow(page, null, `${style.name} reader`);
			}

			await page.getByRole("button", { name: "More actions" }).first().click();
			await page.getByRole("button", { name: "Add to a tracked subscription", exact: true }).click();
			const documentDialog = page.locator("[data-finance-document-dialog]");
			await expect(documentDialog).toBeVisible();
			expect((await documentDialog.boundingBox())!.height).toBeLessThanOrEqual(600 - 64 + 1);
			const record = documentDialog.getByRole("button", { name: "Record document" });
			await record.scrollIntoViewIfNeeded();
			await expect(record).toBeInViewport();
			await page.keyboard.press("Escape");
			expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
		} finally {
			await context.close();
			await account.api.dispose();
			await restore();
		}
	});
});
