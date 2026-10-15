import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { createSignedInAccount, okJson, selectMailbox } from "./auto-read";
import { BASE_URL, DOMAIN } from "./constants";
import type { InboundMail } from "./helpers-types";
import { postInbound, uniqueToken, waitForMessage } from "./helpers";
import { readSuggestions, waitForFinishedJob } from "./triage";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Only Cloudflare's own Authentication-Results are trusted.
export const AUTH_PASS =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=vendor.test; dkim=pass header.d=vendor.test; dmarc=pass";
const AUTOMATIC = { "Auto-Submitted": "auto-generated", "Authentication-Results": AUTH_PASS };

/** A day `days` from now in UTC, as the mail states it and as the card shows it. */
export function dayFromNow(days: number) {
	const date = new Date(Date.now() + days * 86_400_000);
	const day = date.getUTCDate();
	const month = MONTHS[date.getUTCMonth()];
	return { long: `${day} ${month} ${date.getUTCFullYear()}`, short: `${day} ${month}` };
}

export const isoDay = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const uniqueVendor = (prefix: string) => `${prefix}${uniqueToken("").slice(-4)}`;

/** A new account with its own mailbox, signed in on its own client; `suggest` turns automatic reading on. */
export async function financeAccount(admin: APIRequestContext, prefix: string, { suggest = false } = {}) {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(admin, username);
	if (suggest)
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
	return { ...account, address: `${username}@${DOMAIN}` };
}

export type Account = Awaited<ReturnType<typeof financeAccount>>;

/** Delivers mail to the account, waits for its triage job and returns the message with its subscription cards. */
export async function deliver(account: Account, mail: Omit<InboundMail, "to">) {
	await postInbound(account.api, { ...mail, to: account.address });
	const message = await waitForMessage(account.api, mail.subject, { status: "received" });
	const job = await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
	const { suggestions } = await readSuggestions(account.api, { mailboxId: account.mailboxId, messageId: message.id });
	return { message, job, cards: suggestions.filter((item) => item.kind === "subscription") };
}

/** Delivers mail to an account whose automatic reading may be off, so no triage job is awaited. */
export async function deliverPlain(
	account: { api: APIRequestContext; address: string },
	mail: Omit<InboundMail, "to">,
) {
	await postInbound(account.api, { ...mail, to: account.address });
	return waitForMessage(account.api, mail.subject, { status: "received" });
}

export function invoice(vendor: string, renews: string, extra: Partial<InboundMail> = {}): Omit<InboundMail, "to"> {
	return {
		from: `${vendor} Billing <billing@${vendor.toLowerCase()}.test>`,
		subject: `Your ${vendor} invoice ${uniqueToken("inv")}`,
		text: `Thanks for your payment.\nInvoice INV-1001\nPlan: Premium $17.99/month, renews on ${renews}.\n`,
		headers: AUTOMATIC,
		...extra,
	};
}

export const subscriptionBlock = (page: Page) => page.locator('[data-suggestion-block="subscription"]');

export type SubscriptionView = {
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
export type Totals = { currency: string; monthlyMinor: number; paidLast12MonthsMinor: number }[];
export type DocumentView = { id: string; docType: string; messageId: string | null; attachmentId: string | null };
export type ActivityRow = {
	id: string;
	action: string;
	variant: string;
	undoOf: string | null;
	target?: { href: string | null; label?: string; unavailable?: boolean };
};

type Client = { api: APIRequestContext };

export async function listSubscriptions(account: Client) {
	return okJson<{ subscriptions: SubscriptionView[]; totals: Totals }>(
		await account.api.get("/api/finance/subscriptions"),
	);
}

export async function subscriptionDetail(account: Client, id: string) {
	return okJson<{ subscription: SubscriptionView; documents: DocumentView[] }>(
		await account.api.get(`/api/finance/subscriptions/${id}`),
	);
}

export async function acceptCard(account: Client, id: string, option: string) {
	return okJson<{ actionId: string; subscription: { kind: string; id: string }; documentRecorded: boolean | null }>(
		await account.api.post(`/api/agent/suggestions/${id}/accept`, { data: { option } }),
	);
}

export async function undo(account: Client, actionId: string) {
	await okJson(await account.api.post(`/api/agent/actions/${actionId}/undo`));
}

export async function activity(account: Client & { mailboxId: string }) {
	const { actions } = await okJson<{ actions: ActivityRow[] }>(
		await account.api.get(`/api/agent/actions?mailboxId=${account.mailboxId}`),
	);
	return actions;
}

export type CalendarEventRow = { id: string; title: string; icalUid: string | null; startsAt: string; endsAt: string };
type NoticeFrame = { type: string; moduleId: string; notice: string; title: string; href: string | null };

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
export async function openRealtimePage(
	browser: Browser,
	account: { id: string; api: APIRequestContext; mailboxId: string },
) {
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

export async function noticeFrames(page: Page): Promise<NoticeFrame[]> {
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
export async function cronTick(api: APIRequestContext) {
	const response = await api.get(`/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
	// Local workerd reports the event as "exception" when a webhook subrequest fails its DNS lookup
	// (the e2e hooks point at `.invalid` hosts), even though the dispatcher caught the error; callers
	// assert the reminders themselves.
	expect(response.ok() || (await response.text()) === "exception", await response.text()).toBe(true);
}

export async function reminderEvents(account: Client, subscriptionId: string) {
	const start = new Date(Date.now() - 86_400_000).toISOString();
	const end = new Date(Date.now() + 10 * 86_400_000).toISOString();
	const { events } = await okJson<{ events: CalendarEventRow[] }>(
		await account.api.get(`/api/calendar/events?start=${start}&end=${end}`),
	);
	return events.filter((event) => event.icalUid === `finance-renewal:${subscriptionId}`);
}

/** Adds a $17.99 monthly row by hand that renews in 2 days with a 3-day reminder and a calendar event. */
export async function trackRenewing(account: Client & { mailboxId: string }, vendor: string) {
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
