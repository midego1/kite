import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, deliverInbound, suppressMailboxTour, uniqueToken, waitForMessage } from "./support/helpers";
import { turnScreenerOff } from "./support/screener";
import { chooseOption, expectSelectValue } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Compact labels in the message list and the connected-account views (docs/external-accounts.md#connected-account-views,
// docs/all-mailboxes.md): in All mailboxes a row marks its mailbox with a coloured dot and a connected account's mail
// with a link icon (Compact, the default), as text chips (Full) or not at all (Off); the open message keeps the full
// chip. Each connected account is a sidebar view of the Inbox showing only mail that came in through it.

const APP_PASSWORD = "fake-app-password";
const ACCOUNT_LABEL = "Demo Gmail";

type Listed = { id: string; subject: string | null };

test.describe.configure({ mode: "serial" });

let user: Awaited<ReturnType<typeof createSignedInAccount>>;
let storageState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let fake: Awaited<ReturnType<typeof startFakeImap>>;
let token: string;
let address: string;
let homeName: string;
let workId: string;
let subjects: { synced: string; second: string; direct: string; work: string };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function checkNow(api: APIRequestContext, accountId: string) {
	await expect
		.poll(async () => (await api.post(`/api/external-accounts/${accountId}/sync`)).status(), {
			timeout: 90_000,
			intervals: [5_000],
		})
		.toBe(202);
}

test.beforeAll(async () => {
	test.setTimeout(240_000);
	token = uniqueToken("lbl");
	address = `${token}@example.test`;
	subjects = {
		synced: `${token} from the account`,
		second: `${token} also from the account`,
		direct: `${token} direct`,
		work: `${token} for work`,
	};
	fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD }, folders: { INBOX: [] } });
	const admin = await apiContext(STORAGE_STATE);
	homeName = `lb${token.slice(-8)}`;
	user = await createSignedInAccount(admin, homeName);
	const { domains } = await json<{ domains: { id: string }[] }>(await admin.get("/api/domains"));
	const work = await json<{ id: string }>(
		await admin.post("/api/mailboxes", {
			data: { domainId: domains[0]!.id, localPart: `work${token}`, displayName: "Work desk", ownerUserId: user.id },
		}),
	);
	await admin.dispose();
	workId = work.id;
	await turnScreenerOff(user.api, work.id);

	const account = (
		await json<{ account: { id: string } }>(
			await user.api.post("/api/external-accounts", {
				data: {
					address,
					label: ACCOUNT_LABEL,
					preset: "other",
					mailboxId: user.mailboxId,
					imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
					password: APP_PASSWORD,
					kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
				},
			}),
		)
	).account;
	fake.addMessage("INBOX", sampleMessage(1, { subject: subjects.synced }));
	fake.addMessage("INBOX", sampleMessage(2, { subject: subjects.second }));
	await checkNow(user.api, account.id);
	await waitForMessage(user.api, subjects.synced);
	await waitForMessage(user.api, subjects.second);
	const { mailboxes } = await json<{ mailboxes: { id: string; localPart: string; hostname: string }[] }>(
		await user.api.get("/api/mailboxes"),
	);
	const home = mailboxes.find((mailbox) => mailbox.id === user.mailboxId)!;
	const workBox = mailboxes.find((mailbox) => mailbox.id === work.id)!;
	await deliverInbound(user.api, {
		from: `"Outside Sender" <sender@outside.test>`,
		to: `${home.localPart}@${home.hostname}`,
		subject: subjects.direct,
	});
	await deliverInbound(user.api, {
		from: `"Outside Sender" <sender@outside.test>`,
		to: `${workBox.localPart}@${workBox.hostname}`,
		subject: subjects.work,
	});
	storageState = await user.api.storageState();
});

test.afterAll(async () => {
	await user?.api.dispose();
	await fake?.close();
});

async function openPage(browser: Browser, viewport?: { width: number; height: number }): Promise<Page> {
	const context = await browser.newContext({ storageState, ...(viewport ? { viewport, hasTouch: true } : {}) });
	const page = await context.newPage();
	await suppressMailboxTour(page);
	return page;
}

async function showAllMailboxes(page: Page) {
	await page.goto("/inbox");
	const trigger = page.getByRole("button", { name: /^Switch mailbox, current:/ });
	await expect(trigger).toBeVisible({ timeout: 60_000 });
	await trigger.click();
	await page
		.getByRole("dialog", { name: "Switch mailbox" })
		.getByRole("option", { name: /All mailboxes/ })
		.click();
	await expect(page.getByRole("button", { name: "Switch mailbox, current: All mailboxes" })).toBeVisible();
}

function row(page: Page, subject: string) {
	return page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) });
}

/**
 * Clicks a sidebar view's link until its title shows. Right after choosing All mailboxes the page may still be finishing
 * the navigation that choice started, which would land after the click and put the plain Inbox back.
 */
async function openView(link: Locator, title: Locator) {
	await expect(async () => {
		await link.click();
		await expect(title).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 45_000 });
}

async function chooseLabels(page: Page, name: "Compact" | "Full" | "Off") {
	await page.goto("/settings/inbox");
	const select = page.getByRole("combobox", { name: "Labels in the message list" });
	await expect(select).toBeVisible({ timeout: 60_000 });
	await chooseOption(select, name.toLowerCase());
	await expectSelectValue(select, name.toLowerCase());
	// A line under the setting shows what each marker means, in the look that is chosen.
	const legend = page.locator("[data-labels-legend]");
	if (name === "Compact") {
		await expect(legend).toContainText("The mailbox the mail is in");
		await expect(legend).toContainText("Came in through a connected account");
		await expect(legend.locator("[data-label-dot]")).toHaveCount(1);
	} else if (name === "Full") {
		await expect(legend).toContainText("via Gmail");
		await expect(legend.locator("[data-label-dot]")).toHaveCount(0);
	} else await expect(page.getByText("Rows carry no mailbox or account marker.")).toBeVisible();
}

test("Compact rows mark mailbox and account with a dot and an icon, Full and Off change that, and rows keep their height", async ({
	browser,
}) => {
	const page = await openPage(browser);
	await showAllMailboxes(page);
	const synced = row(page, subjects.synced);
	await expect(synced).toBeVisible({ timeout: 60_000 });

	// Compact is the default: a dot and an icon, named for assistive technology, with no text of their own.
	const group = async (name: "Compact" | "Full" | "Off") => {
		await chooseLabels(page, name);
		await page.goto("/inbox");
		await expect(row(page, subjects.synced)).toBeVisible({ timeout: 60_000 });
	};
	await expect(synced.locator("[data-via-account]")).toHaveAttribute("data-label-variant", "compact");
	await expect(synced.locator("[data-via-account]")).toHaveAttribute("aria-label", `via ${ACCOUNT_LABEL}`);
	await expect(synced.locator("[data-via-account]")).toHaveAttribute("title", new RegExp(`through ${address}$`));
	await expect(synced.locator("[data-via-account]")).toHaveText("");
	const dot = synced.getByTestId("message-mailbox-label");
	await expect(dot).toHaveAttribute("data-label-variant", "compact");
	await expect(dot).toHaveAttribute("aria-label", `Mailbox: ${homeName}`);
	await expect(dot).toHaveAttribute("title", new RegExp(`^Mailbox: ${homeName} \\(`));
	await expect(dot).toHaveText("");
	// A rounded square, never the round dot that means "unread" beside the avatar.
	const radius = await dot
		.locator("[data-label-dot]")
		.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius));
	expect(radius).toBeGreaterThan(0);
	expect(radius).toBeLessThanOrEqual(4);
	const work = row(page, subjects.work).getByTestId("message-mailbox-label");
	await expect(work).toHaveAttribute("aria-label", "Mailbox: Work desk");
	await expect(row(page, subjects.direct).locator("[data-via-account]")).toHaveCount(0);
	const colour = (locator: typeof dot) =>
		locator.locator("span[aria-hidden]").evaluate((node) => getComputedStyle(node).backgroundColor);
	const dotColour = await colour(dot);
	expect(dotColour).not.toBe("rgba(0, 0, 0, 0)");

	const subject = (name: string) => row(page, name).getByText(name, { exact: true });
	const compactWidth = (await subject(subjects.synced).boundingBox())!.width;
	const compactHeight = (await synced.boundingBox())!.height;

	// Full is today's look: the text chips, which take the subject's room.
	await group("Full");
	const full = row(page, subjects.synced);
	await expect(full.locator("[data-via-account]")).toHaveText(`via ${ACCOUNT_LABEL}`);
	await expect(full.getByTestId("message-mailbox-label")).toHaveText(`Mailbox: ${homeName}`);
	// The dot keeps the mailbox's colour in both looks.
	expect(await colour(full.getByTestId("message-mailbox-label"))).toBe(dotColour);
	expect((await subject(subjects.synced).boundingBox())!.width).toBeLessThan(compactWidth);
	expect(Math.abs((await full.boundingBox())!.height - compactHeight)).toBeLessThanOrEqual(1);

	// Off hides both from the rows, and only from the rows.
	await group("Off");
	const off = row(page, subjects.synced);
	await expect(off.locator("[data-via-account]")).toHaveCount(0);
	await expect(page.getByTestId("message-mailbox-label")).toHaveCount(0);
	expect((await subject(subjects.synced).boundingBox())!.width).toBeGreaterThanOrEqual(compactWidth);
	expect(Math.abs((await off.boundingBox())!.height - compactHeight)).toBeLessThanOrEqual(1);
	await off.getByRole("link").first().click();
	await expect(
		page.getByRole("button", { name: new RegExp(`^via ${ACCOUNT_LABEL}: show all mail through`) }),
	).toBeVisible({
		timeout: 30_000,
	});

	// The choice follows the account: a fresh browser with the same sign-in starts on it.
	const other = await openPage(browser);
	await other.goto("/inbox");
	await expect(other.getByRole("list", { name: "Inbox" }).locator("[data-message-row]").first()).toBeVisible({
		timeout: 60_000,
	});
	await expect(other.locator("[data-via-account]")).toHaveCount(0);
	await group("Compact");
	await page.context().close();
	await other.context().close();
});

test("Compact labels fit a phone, and the name is still reachable", async ({ browser }) => {
	const page = await openPage(browser, { width: 390, height: 844 });
	await page.addInitScript(() => localStorage.setItem("kite-all-mailboxes", "true"));
	await page.goto("/inbox");
	const synced = row(page, subjects.synced);
	await expect(synced).toBeVisible({ timeout: 60_000 });
	await expect(synced.locator("[data-via-account][data-label-variant=compact]")).toBeVisible();
	await expect(synced.getByTestId("message-mailbox-label")).toHaveAttribute("aria-label", `Mailbox: ${homeName}`);
	const box = (await synced.boundingBox())!;
	const subjectBox = (await synced.getByText(subjects.synced, { exact: true }).boundingBox())!;
	expect(subjectBox.x + subjectBox.width).toBeLessThanOrEqual(box.x + box.width);
	await page.context().close();
});

test("on a wide list the compact markers can be hovered, so their names show", async ({ browser }) => {
	const page = await openPage(browser);
	await page.addInitScript(() => localStorage.setItem("kite-reading-pane", "none"));
	await showAllMailboxes(page);
	const synced = row(page, subjects.synced);
	await expect(synced).toBeVisible({ timeout: 60_000 });
	// Rows with and without the account's icon start their subjects in the same column.
	const startOf = async (subject: string) =>
		(await row(page, subject).getByText(subject, { exact: true }).boundingBox())!.x;
	expect(await startOf(subjects.direct)).toBeCloseTo(await startOf(subjects.synced), 0);
	expect(await startOf(subjects.work)).toBeCloseTo(await startOf(subjects.synced), 0);
	// The row's link overlays it; hovering only works when the marker is above that overlay.
	await synced.locator("[data-via-account]").hover({ timeout: 5_000 });
	await synced.getByTestId("message-mailbox-label").hover({ timeout: 5_000 });
	// Above the overlay does not mean out of the row: a click on a marker still opens the message.
	await synced.getByTestId("message-mailbox-label").click();
	await expect(page.getByRole("heading", { level: 1, name: subjects.synced })).toBeVisible({ timeout: 30_000 });
	await page.context().close();
});

test("a connected account is a sidebar view listing only mail that came in through it", async ({ browser }) => {
	const page = await openPage(browser);
	await showAllMailboxes(page);
	const sidebar = page.getByTestId("kite-sidebar-panel");
	// In All mailboxes the account is listed under the mailbox it delivers into, with a first-use explanation.
	const link = sidebar.getByRole("group", { name: /connected accounts$/ }).getByRole("link", { name: ACCOUNT_LABEL });
	await expect(link).toBeVisible({ timeout: 60_000 });
	await expect(link).toHaveAttribute("title", `Shows only mail that came in through ${address}. Nothing is moved.`);
	await expect(sidebar.getByText("Nothing is moved.", { exact: false }).first()).toBeVisible();
	await expect(sidebar.locator("[data-accounts-hint]")).toBeVisible();
	await expect(page.getByRole("group", { name: "Work desk connected accounts" })).toHaveCount(0);

	const title = page.locator(`[data-account-view-title="${address}"]`);
	await openView(link, title);
	// The view is not a search: the box stays empty, the list is titled with the view, and the way back is beside it.
	const searchBox = page.getByRole("textbox", { name: /Search mail/ }).first();
	await expect(searchBox).toHaveValue("");
	await expect(title).toContainText(ACCOUNT_LABEL);
	await expect(title.locator("p")).toHaveAttribute("title", `Only mail that came in through ${address}`);
	await expect(row(page, subjects.synced)).toBeVisible({ timeout: 30_000 });
	await expect(row(page, subjects.direct)).toHaveCount(0);
	await expect(row(page, subjects.work)).toHaveCount(0);
	await expect(link).toHaveAttribute("aria-current", "page");
	// The Inbox row is not highlighted as well: the view is the one place you are.
	await expect(page.locator('a[href="/inbox"]').first()).not.toHaveClass(/bg-blue-100/);
	// Opening a view was the first use: the explanation is gone.
	await expect(sidebar.locator("[data-accounts-hint]")).toHaveCount(0);

	// Typing inside the view searches within it.
	await searchBox.fill("nothing-matches-this");
	await expect(row(page, subjects.synced)).toHaveCount(0);
	await searchBox.fill(token);
	await expect(row(page, subjects.synced)).toBeVisible({ timeout: 30_000 });
	await expect(row(page, subjects.direct)).toHaveCount(0);
	await page.getByRole("button", { name: "Clear search" }).first().click();
	await expect(row(page, subjects.synced)).toBeVisible();
	await expect(title).toBeVisible();

	// A reload opens the same view from the address.
	await page.reload();
	await expect(page.locator(`[data-account-view-title="${address}"]`)).toBeVisible({ timeout: 60_000 });
	await expect(searchBox).toHaveValue("");
	await expect(row(page, subjects.synced)).toBeVisible({ timeout: 60_000 });
	await expect(row(page, subjects.direct)).toHaveCount(0);

	// The way back leaves the view, and a reload stays out of it.
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 30_000 });
	await expect(title).toHaveCount(0);
	await expect(link).not.toHaveAttribute("aria-current", "page");
	await expect(page.locator('a[href="/inbox"]').first()).toHaveClass(/bg-blue-100/);
	await page.reload();
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 60_000 });
	await expect(page.locator("[data-account-view-title]")).toHaveCount(0);
	await page.context().close();
});

test("the sidebar's Inbox and the browser's Back leave a view, as the address does", async ({ browser }) => {
	const page = await openPage(browser);
	await page.goto("/inbox");
	const sidebar = page.getByTestId("kite-sidebar-panel");
	const link = sidebar.getByRole("link", { name: ACCOUNT_LABEL });
	await expect(link).toBeVisible({ timeout: 60_000 });
	const title = page.locator(`[data-account-view-title="${address}"]`);

	await openView(link, title);
	await expect(row(page, subjects.direct)).toHaveCount(0);
	await expect(page).toHaveURL(/\/inbox\?via=/);

	// The sidebar's Inbox goes back to the whole list at once: no filter, no highlighted view, no stuck progress bar.
	await sidebar.locator('a[href="/inbox"]').first().click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 30_000 });
	await expect(title).toHaveCount(0);
	await expect(link).not.toHaveAttribute("aria-current", "page");
	await expect(page.locator("div.fixed.inset-x-0.top-0.bg-blue-100")).toHaveCount(0, { timeout: 2_000 });

	// Back returns to the view, and Back again to the list; the list always matches the address.
	await page.goBack();
	await expect(title).toBeVisible();
	await expect(row(page, subjects.direct)).toHaveCount(0);
	await expect(link).toHaveAttribute("aria-current", "page");
	await page.goBack();
	await expect(title).toHaveCount(0);
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 30_000 });
	await page.goForward();
	await expect(title).toBeVisible();

	// The back arrow is a history step too.
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(title).toHaveCount(0);
	await page.goBack();
	await expect(title).toBeVisible();

	// Emptying a folder is not offered inside a view: it would empty the whole folder.
	await page.goto(`/trash?via=${encodeURIComponent(address)}`);
	await expect(page.locator(`[data-account-view-title="${address}"]`)).toBeVisible({ timeout: 60_000 });
	await expect(page.getByRole("button", { name: "Empty Trash" })).toHaveCount(0);
	await page.goto("/trash");
	await expect(page.getByRole("button", { name: "Empty Trash" })).toBeVisible({ timeout: 60_000 });
	await page.context().close();
});

test("opening a message, Newer and Older, archiving it and the phone's back arrow all stay inside the view", async ({
	browser,
}) => {
	const page = await openPage(browser);
	await page.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), user.mailboxId);
	await page.goto(`/inbox?via=${encodeURIComponent(address)}`);
	const title = page.locator(`[data-account-view-title="${address}"]`);
	await expect(title).toBeVisible({ timeout: 60_000 });
	await expect(row(page, subjects.synced)).toBeVisible();
	await expect(row(page, subjects.second)).toBeVisible();
	await expect(row(page, subjects.direct)).toHaveCount(0);
	const inView = async () => {
		await expect(page).toHaveURL(/via=/);
		await expect(title).toBeVisible();
		await expect(row(page, subjects.direct)).toHaveCount(0);
	};

	// Opening a row keeps the title, the back arrow and the filtered list (no refetch of the whole Inbox).
	await row(page, subjects.synced).getByRole("link").first().click();
	await expect(page).toHaveURL(/\/inbox\/[^?]+\?via=/);
	await expect(page.getByRole("heading", { level: 1, name: subjects.synced })).toBeVisible({ timeout: 30_000 });
	await inView();
	await expect(row(page, subjects.second)).toBeVisible();

	// Newer and Older move between the view's messages, still inside the view.
	const other = page.locator(
		'button[aria-label="Newer email"]:not([disabled]), button[aria-label="Older email"]:not([disabled])',
	);
	await other.first().click();
	await expect(page.getByRole("heading", { level: 1, name: subjects.second })).toBeVisible({ timeout: 30_000 });
	await inView();

	// Archiving the open message leaves it for the list of the view, not for the whole Inbox.
	await page
		.getByRole("button", { name: /^Archive/ })
		.last()
		.click();
	await expect(page).toHaveURL(/\/inbox\?via=/, { timeout: 30_000 });
	await inView();
	await expect(row(page, subjects.second)).toHaveCount(0);
	await expect(row(page, subjects.synced)).toBeVisible();
	await page.context().close();

	// On a phone the back arrow of an open message returns to the view's list.
	const phone = await openPage(browser, { width: 390, height: 844 });
	await phone.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), user.mailboxId);
	await phone.goto(`/inbox?via=${encodeURIComponent(address)}`);
	await expect(phone.locator(`[data-account-view-title="${address}"]`)).toBeVisible({ timeout: 60_000 });
	await row(phone, subjects.synced).getByRole("link").first().click();
	await expect(phone.getByRole("heading", { level: 1, name: subjects.synced })).toBeVisible({ timeout: 30_000 });
	await phone.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(phone).toHaveURL(/\/inbox\?via=/);
	await expect(phone.locator(`[data-account-view-title="${address}"]`)).toBeVisible();
	await expect(row(phone, subjects.synced)).toBeVisible();
	await expect(row(phone, subjects.direct)).toHaveCount(0);
	await phone.context().close();
});

test("a view is left when the mailbox is switched to one that does not receive the account's mail", async ({
	browser,
}) => {
	const page = await openPage(browser);
	await page.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), user.mailboxId);
	await page.goto(`/inbox?via=${encodeURIComponent(address)}`);
	const title = page.locator(`[data-account-view-title="${address}"]`);
	await expect(title).toBeVisible({ timeout: 60_000 });
	await expect(row(page, subjects.synced)).toBeVisible();
	const trigger = page.getByRole("button", { name: /^Switch mailbox, current:/ });
	await trigger.click();
	await page
		.getByRole("dialog", { name: "Switch mailbox" })
		.getByRole("option", { name: /Work desk/ })
		.click();
	await expect(title).toHaveCount(0, { timeout: 15_000 });
	await expect(page).not.toHaveURL(/via=/);
	await expect(row(page, subjects.work)).toBeVisible({ timeout: 30_000 });
	await page.context().close();
});

test("on a phone choosing a view closes the menu, and a view opened from a link is trimmed and ignores an empty value", async ({
	browser,
}) => {
	const page = await openPage(browser, { width: 390, height: 844 });
	await page.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), user.mailboxId);
	await page.goto("/inbox");
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: "Open menu" }).click();
	const sheet = page.getByRole("dialog", { name: "Menu" });
	await expect(sheet).toBeVisible();
	await sheet.getByRole("link", { name: ACCOUNT_LABEL }).click();
	// The page was already the Inbox, so only the view's own handler can close the sheet.
	await expect(sheet).toHaveCount(0);
	await expect(page.locator(`[data-account-view-title="${address}"]`)).toBeVisible();
	await expect(row(page, subjects.synced)).toBeVisible();
	await expect(row(page, subjects.direct)).toHaveCount(0);

	await page.goto(`/inbox?via=%20${encodeURIComponent(address)}%20`);
	await expect(page.locator(`[data-account-view-title="${address}"]`)).toBeVisible({ timeout: 60_000 });
	await page.goto("/inbox?via=%20");
	await expect(row(page, subjects.direct)).toBeVisible({ timeout: 60_000 });
	await expect(page.locator("[data-account-view-title]")).toHaveCount(0);
	await page.context().close();
});

test("the reader's account chip opens the same view, and a single mailbox lists only its own accounts", async ({
	browser,
}) => {
	const page = await openPage(browser);
	await page.goto("/inbox");
	const link = page.getByTestId("kite-sidebar-panel").getByRole("link", { name: ACCOUNT_LABEL });
	await expect(link).toBeVisible({ timeout: 60_000 });
	await row(page, subjects.synced).getByRole("link").first().click();
	const chip = page.getByRole("button", {
		name: new RegExp(`^via ${ACCOUNT_LABEL}: show all mail through ${address}`),
	});
	await expect(chip).toBeVisible({ timeout: 30_000 });
	await chip.click();
	await expect(page.getByRole("textbox", { name: /Search mail/ }).first()).toHaveValue("");
	await expect(page.locator(`[data-account-view-title="${address}"]`)).toBeVisible();
	await expect(link).toHaveAttribute("aria-current", "page");

	// The account delivers into the first mailbox; the work mailbox lists no accounts.
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await page.getByRole("button", { name: /^Open work/ }).click();
	await expect(link).toHaveCount(0);
	await expect(page.getByTestId("kite-sidebar-panel").getByRole("button", { name: "Connected accounts" })).toHaveCount(
		0,
	);
	await page.context().close();
});

const rgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function layoutOf(api: APIRequestContext) {
	return (
		await json<{
			layout: { labelColors?: { mailboxes?: Record<string, string>; accounts?: Record<string, string> } } | null;
		}>(await api.get("/api/settings/layout"))
	).layout;
}

test("each mailbox and account gets a colour of its own choosing, shown in rows, sidebar and settings, and kept on the account", async ({
	browser,
}) => {
	const page = await openPage(browser);
	await showAllMailboxes(page);
	const synced = row(page, subjects.synced);
	await expect(synced).toBeVisible({ timeout: 60_000 });
	const dot = (scope: ReturnType<typeof row>) => scope.getByTestId("message-mailbox-label").locator("[data-label-dot]");
	const automatic = await dot(synced).getAttribute("data-label-dot");
	expect(automatic).toMatch(/^#[0-9a-f]{6}$/);
	const squares = page.getByRole("button", { name: /^Open lb/ });
	await expect(squares.locator("[data-label-dot]").first()).toBeVisible();

	// Settings → Inbox → Label colours: a mailbox, then a connected account.
	await page.goto("/settings/inbox");
	const mailboxPicker = page.getByRole("radiogroup", { name: `Colour for ${homeName}` });
	await expect(mailboxPicker).toBeVisible({ timeout: 60_000 });
	await expect(mailboxPicker.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
	await mailboxPicker.getByRole("radio", { name: "Pink" }).click();
	await expect(mailboxPicker.getByRole("radio", { name: "Pink" })).toHaveAttribute("aria-checked", "true");
	const workPicker = page.getByRole("radiogroup", { name: "Colour for Work desk" });
	await workPicker.getByRole("radio", { name: "Green" }).click();
	await expect(workPicker.getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");
	const accountPicker = page.getByRole("radiogroup", { name: `Colour for ${ACCOUNT_LABEL}` });
	await accountPicker.getByRole("radio", { name: "Teal" }).click();
	await expect(accountPicker.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");

	await page.goto("/inbox");
	const colored = row(page, subjects.synced);
	await expect(colored).toBeVisible({ timeout: 60_000 });
	await expect(dot(colored)).toHaveAttribute("data-label-dot", "#e64a92");
	await expect(colored.locator("[data-via-account] svg")).toHaveCSS("color", rgb("#25958d"));
	// Another mailbox keeps its own colour, and the sidebar shows the same ones.
	await expect(dot(row(page, subjects.work))).toHaveAttribute("data-label-dot", "#1f9a46");
	await expect(
		page.getByRole("button", { name: new RegExp(`^Open ${homeName}`) }).locator('[data-label-dot="#e64a92"]'),
	).toBeVisible();
	const sidebar = page.getByTestId("kite-sidebar-panel");
	await expect(sidebar.getByRole("link", { name: ACCOUNT_LABEL }).locator("svg")).toHaveCSS("color", rgb("#25958d"));

	// It is saved to the account, so another browser starts with it.
	const accountId = (await json<{ accounts: { id: string }[] }>(await user.api.get("/api/external-accounts")))
		.accounts[0]!.id;
	await expect
		.poll(async () => (await layoutOf(user.api))?.labelColors, { timeout: 30_000 })
		.toEqual({
			mailboxes: { [user.mailboxId]: "pink", [workId]: "green" },
			accounts: { [accountId]: "teal" },
		});
	const other = await openPage(browser);
	await other.addInitScript(() => localStorage.setItem("kite-all-mailboxes", "true"));
	await other.goto("/inbox");
	await expect(dot(row(other, subjects.synced))).toHaveAttribute("data-label-dot", "#e64a92", { timeout: 60_000 });
	await other.context().close();

	// The sidebar entry's menu changes the account's colour too, and the choice reaches the row at once.
	await sidebar.getByRole("link", { name: ACCOUNT_LABEL }).hover();
	await sidebar.getByRole("button", { name: `Colour for ${ACCOUNT_LABEL}` }).click();
	await page
		.getByRole("radiogroup", { name: `Colour for ${ACCOUNT_LABEL}` })
		.getByRole("radio", { name: "Orange" })
		.click();
	await expect(row(page, subjects.synced).locator("[data-via-account] svg")).toHaveCSS("color", rgb("#e6570c"));
	await page.keyboard.press("Escape");

	// Back to automatic and no colour.
	await page.goto("/settings/inbox");
	await mailboxPicker.getByRole("radio", { name: "Automatic" }).click();
	await workPicker.getByRole("radio", { name: "Automatic" }).click();
	await accountPicker.getByRole("radio", { name: "No colour" }).click();
	await expect.poll(async () => (await layoutOf(user.api))?.labelColors, { timeout: 30_000 }).toEqual({});
	await page.goto("/inbox");
	await expect(dot(row(page, subjects.synced))).toHaveAttribute("data-label-dot", automatic!, { timeout: 60_000 });
	await page.context().close();
});

test("colours of mailboxes that are gone are dropped when the settings open", async ({ browser }) => {
	await user.api.patch("/api/settings/layout", {
		data: {
			layout: {
				labelColors: {
					mailboxes: { [user.mailboxId]: "red", "gone-mailbox": "blue" },
					accounts: { "gone-account": "teal" },
				},
			},
		},
	});
	const page = await openPage(browser);
	await page.goto("/settings/inbox");
	await expect(
		page.getByRole("radiogroup", { name: `Colour for ${homeName}` }).getByRole("radio", { name: "Red" }),
	).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
	await expect
		.poll(async () => (await layoutOf(user.api))?.labelColors, { timeout: 30_000 })
		.toEqual({ mailboxes: { [user.mailboxId]: "red" } });
	await user.api.patch("/api/settings/layout", { data: { layout: { labelColors: {} } } });
	await page.context().close();
});

test("someone without connected accounts sees no account views", async ({ browser }) => {
	const context = await browser.newContext({ storageState: STORAGE_STATE });
	const page = await context.newPage();
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" }).locator("[data-message-row]").first()).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByTestId("kite-sidebar-panel").getByRole("button", { name: "Connected accounts" })).toHaveCount(
		0,
	);
	await context.close();
});
