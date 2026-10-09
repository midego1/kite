import { expect, test, type Browser, type Page } from "@playwright/test";
import { SUPPORT_ADDRESS, STORAGE_STATE } from "../../e2e/support/constants";
import { apiContext, openMessage, postInbound, waitForMessage } from "../../e2e/support/helpers";

// Every name, address and domain here is invented; .test and example.com are reserved for documentation.
const MAIL = [
	{
		from: `"Wingtip Toys" <orders@wingtip.test>`,
		subject: "Your order #4821 has shipped",
		html: `<p>Good news: your order is on its way and should arrive on Thursday.</p><p><b>Tracking number:</b> WT-4821-0093</p>`,
	},
	{
		from: `"Fabrikam Billing" <invoices@fabrikam.test>`,
		subject: "Your October invoice is ready",
		html: `<p>Hello,</p><p>Invoice <b>FB-2026-10</b> for <b>€240.00</b> is ready and will be charged to the card on file on 1 November.</p><p>Fabrikam Billing</p>`,
	},
	{
		from: `"Priya Raman" <priya@acme.test>`,
		subject: "Quarterly support metrics",
		html: `<p>Hi team,</p><p>First-response time dropped to 42 minutes this quarter, and 94% of tickets were solved within a day. The full report is in the shared folder.</p><p>Priya</p>`,
	},
	{
		from: `"Northwind Status" <status@northwind.test>`,
		subject: "Scheduled maintenance this Saturday",
		html: `<h2>Planned maintenance</h2><p>The Northwind API will be read-only on Saturday from 06:00 to 07:00 UTC while we upgrade the database cluster. No action is needed.</p>`,
	},
	{
		from: `"Tom Okafor" <tom@adventure-works.test>`,
		subject: "Offsite agenda and travel details",
		html: `<p>Hi all,</p><p>The offsite is confirmed for 14–15 November in Lisbon. Day one is planning, day two is the customer workshop. Please book travel by Friday so we can share rooms.</p><p>Tom</p>`,
	},
	{
		from: `"Lena Fischer" <lena@contoso.test>`,
		subject: "Design review notes for the new onboarding flow",
		html: `<p>Hi,</p><p>Thanks for walking us through the new onboarding flow yesterday. A few notes from the review:</p><ul><li>The domain step is much clearer now that the DNS records are checked automatically.</li><li>Could the mailbox step suggest <i>hello@</i> and <i>support@</i> as starting points?</li><li>The welcome email should link straight to the inbox.</li></ul><p>Happy to pair on any of these this week.</p><p>Best,<br>Lena</p>`,
	},
];
const OPENED = MAIL.at(-1)!;

const EVENTS = [
	{ day: 0, start: "09:00", end: "09:30", title: "Team standup", color: "blue", repeat: "weekdays" },
	{ day: 0, start: "13:00", end: "14:00", title: "Design review: onboarding", color: "violet" },
	{ day: 1, start: "11:00", end: "12:00", title: "Customer call: Contoso", color: "emerald", location: "Video call" },
	{ day: 2, start: "15:00", end: "16:30", title: "Quarterly metrics review", color: "orange" },
	{ day: 3, start: "10:00", end: "11:30", title: "Offsite planning", color: "rose" },
	{ day: 4, start: "14:00", end: "15:00", title: "Release check-in", color: "blue" },
];

const plainText = (html: string) =>
	html
		.replace(/<\/(p|li|h2)>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.trim();

function mondayOfThisWeek(): Date {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
	return today;
}

function at(monday: Date, day: number, time: string): string {
	const [hours, minutes] = time.split(":").map(Number);
	const date = new Date(monday);
	date.setUTCDate(date.getUTCDate() + day);
	date.setUTCHours(hours!, minutes!);
	return date.toISOString();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	for (const mail of MAIL) {
		await postInbound(api, { ...mail, to: `"Support" <${SUPPORT_ADDRESS}>`, text: plainText(mail.html) });
		await waitForMessage(api, mail.subject);
	}
	const { domains } = (await (await api.get("/api/domains")).json()) as { domains: { id: string }[] };
	for (const [localPart, displayName] of [
		["hello", "Hello"],
		["team", "Team"],
	]) {
		const response = await api.post("/api/mailboxes", {
			data: { domainId: domains[0]!.id, localPart, displayName, type: "shared" },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}
	const monday = mondayOfThisWeek();
	for (const { day, start, end, ...event } of EVENTS) {
		const response = await api.post("/api/calendar/events", {
			data: { ...event, startsAt: at(monday, day, start), endsAt: at(monday, day, end), timeZone: "UTC" },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}
	await api.dispose();
});

async function open(browser: Browser, { style = "kite", theme = "light" }: { style?: string; theme?: string } = {}) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: { width: 1440, height: 900 },
		colorScheme: theme === "dark" ? "dark" : "light",
	});
	await context.addInitScript(
		(appearance) => {
			localStorage.setItem("kite-style", appearance.style);
			localStorage.setItem("kite-theme", appearance.theme);
		},
		{ style, theme },
	);
	return context.newPage();
}

async function openLenasMessage(page: Page) {
	await page.goto("/inbox");
	await openMessage(page, OPENED.subject);
	const body = page.locator("iframe").first();
	await expect(body.contentFrame().getByText(/Happy to pair/)).toBeAttached();
	// The frame sizes itself to its document after it renders; a shot taken earlier cuts the body off.
	await expect
		.poll(() =>
			body.evaluate((frame: HTMLIFrameElement) => {
				const root = frame.contentDocument?.documentElement;
				return !!root && root.scrollHeight > 0 && frame.contentWindow!.innerHeight >= root.scrollHeight;
			}),
		)
		.toBe(true);
}

async function capture(page: Page, name: string) {
	await expect(page.getByLabel("Loading", { exact: true })).not.toHaveClass(/opacity-100/);
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0);
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `screenshots/${name}.png`, animations: "disabled", caret: "hide" });
	await page.context().close();
}

for (const [name, appearance] of [
	["inbox", {}],
	["inbox-dark", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await openLenasMessage(page);
		await capture(page, name);
	});
}

test("compose", async ({ browser }) => {
	const page = await open(browser);
	await openLenasMessage(page);
	await page.getByRole("button", { name: "Reply (r)" }).click();
	await page
		.getByRole("textbox", { name: "Message body" })
		.fill(
			"Hi Lena,\n\nThanks for the notes. Suggesting hello@ and support@ is a great idea, I'll add it to the mailbox step. Does Thursday afternoon work to pair on the welcome email?\n\nBest,\nDemo",
		);
	await capture(page, "compose");
});

test("domains", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/domains");
	await page.getByRole("button", { name: "Show details" }).first().click();
	await expect(page.getByRole("main").getByText("example.com").first()).toBeVisible();
	await expect(page.getByRole("main").locator(".animate-pulse")).toHaveCount(0);
	// Opening the details scrolls the page; the shot should start at the page heading.
	await page.evaluate(() => {
		for (const element of document.querySelectorAll("*")) if (element.scrollTop) element.scrollTop = 0;
	});
	await capture(page, "domains");
});

test("mailboxes", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/mailboxes");
	await expect(page.getByRole("main").getByText(SUPPORT_ADDRESS).first()).toBeVisible();
	await capture(page, "mailboxes");
});

test("calendar", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/calendar");
	await expect(page.getByRole("button", { name: /Design review: onboarding/ }).first()).toBeVisible();
	await capture(page, "calendar");
});
