import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
import type { FakeModel } from "./support/fake-model-types";
import type { InboundMail } from "./support/helpers-types";
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

	test("case 2: a second invoice updates the price, a refund lowers the 12-month total, and undo restores both", async () => {
		const restore = await useFakeProvider(api, fake);
		const account = await suggestAccount("ftp");
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
			await undo(account, recorded.actionId);
			expect(await paidTotal(account)).toBe(3798);

			await undo(account, updated.actionId);
			const restored = (await listSubscriptions(account)).subscriptions[0];
			expect(restored).toMatchObject({ amount: { minor: 1799 }, previousAmountMinor: null, priceChangedAt: null });
			expect((await subscriptionDetail(account, subscriptionId)).documents).toMatchObject([
				{ docType: "invoice", messageId: first.message.id },
			]);
		} finally {
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
