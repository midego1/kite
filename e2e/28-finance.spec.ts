import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
