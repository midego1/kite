import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Gmail-style keys on the three-pane inbox: j/k between rows, Enter or o to open, j/k between emails in the
// reader, e and # to archive and trash, x to select, r/a/f to reply, reply all and forward, / to search
// and Cmd+K for the command palette.

async function deliverMany(labels: string[]): Promise<string[]> {
	const api = await apiContext(STORAGE_STATE);
	const subjects: string[] = [];
	for (const label of labels) {
		const subject = `${label} ${uniqueToken()}`;
		await deliverInbound(api, {
			from: `"Keys Sender" <keys@outside.test>`,
			to: SUPPORT_ADDRESS,
			headers: { Cc: "teammate@outside.test" },
			subject,
			text: `Body of ${label}.`,
		});
		subjects.push(subject);
	}
	await api.dispose();
	return subjects;
}

function inboxList(page: Page) {
	return page.getByRole("list", { name: "Inbox" });
}

function rowLink(page: Page, subject: string) {
	return inboxList(page)
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link");
}

async function openInbox(page: Page, newest: string) {
	await page.goto("/inbox");
	await expect(rowLink(page, newest)).toBeVisible();
}

test("j and k move between rows, Enter opens, and j and k then move between emails", async ({ page }) => {
	// Delivered oldest first, so the list shows them newest first: C, B, A.
	const [a, b, c] = await deliverMany(["Keys A", "Keys B", "Keys C"]);
	await openInbox(page, c);

	await page.keyboard.press("j");
	await expect(rowLink(page, c)).toBeFocused();
	await page.keyboard.press("j");
	await expect(rowLink(page, b)).toBeFocused();
	await page.keyboard.press("k");
	await expect(rowLink(page, c)).toBeFocused();
	await page.keyboard.press("j");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { level: 1, name: b })).toBeVisible();

	// In the reader j is the older email below in the list and k the newer one above.
	await page.keyboard.press("j");
	await expect(page.getByRole("heading", { level: 1, name: a })).toBeVisible();
	await page.keyboard.press("k");
	await expect(page.getByRole("heading", { level: 1, name: b })).toBeVisible();
});

test("o opens the focused row and x selects it", async ({ page }) => {
	const [first, second] = await deliverMany(["Keys open", "Keys select"]);
	await openInbox(page, second);

	await page.keyboard.press("j");
	await expect(rowLink(page, second)).toBeFocused();
	await page.keyboard.press("x");
	await expect(page.getByText("1 selected")).toBeVisible();
	await page.keyboard.press("x");
	await expect(page.getByText("1 selected")).toHaveCount(0);

	await page.keyboard.press("j");
	await expect(rowLink(page, first)).toBeFocused();
	await page.keyboard.press("o");
	await expect(page.getByRole("heading", { level: 1, name: first })).toBeVisible();
});

test("e archives and # trashes the focused row or the open email", async ({ page }) => {
	const [trashed, archived, open] = await deliverMany(["Keys trash", "Keys archive", "Keys reader"]);
	await openInbox(page, open);

	await page.keyboard.press("j");
	await page.keyboard.press("j");
	await expect(rowLink(page, archived)).toBeFocused();
	await page.keyboard.press("e");
	await expect(rowLink(page, archived)).toHaveCount(0);

	await page.keyboard.press("j");
	await expect(rowLink(page, open)).toBeFocused();
	await page.keyboard.press("j");
	await expect(rowLink(page, trashed)).toBeFocused();
	await page.keyboard.press("#");
	await expect(rowLink(page, trashed)).toHaveCount(0);

	await rowLink(page, open).click();
	await expect(page.getByRole("heading", { level: 1, name: open })).toBeVisible();
	await page.keyboard.press("e");
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(rowLink(page, open)).toHaveCount(0);

	await page.goto("/archived");
	await expect(page.getByRole("main").getByText(archived, { exact: true })).toBeVisible();
	await expect(page.getByRole("main").getByText(open, { exact: true })).toBeVisible();
	await page.goto("/trash");
	await expect(page.getByRole("main").getByText(trashed, { exact: true })).toBeVisible();
});

test("r, a and f open the composer with a reply, a reply to all and a forward", async ({ page }) => {
	const [subject] = await deliverMany(["Keys reply"]);
	await openInbox(page, subject);
	await rowLink(page, subject).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	for (const [key, expected, cc] of [
		["r", `Re: ${subject}`, false],
		["a", `Re: ${subject}`, true],
		["f", `Fwd: ${subject}`, false],
	] as const) {
		await page.keyboard.press(key);
		const composerSubject = page.getByLabel("Subject");
		await expect(composerSubject).toHaveValue(expected);
		if (cc) await expect(page.getByText("teammate@outside.test").first()).toBeVisible();
		await page.getByRole("button", { name: "Close composer" }).click();
		await expect(composerSubject).toHaveCount(0);
	}

	// The reply box under the message opens the same reply.
	await page.getByRole("button", { name: /^Reply to Keys Sender/ }).click();
	await expect(page.getByLabel("Subject")).toHaveValue(`Re: ${subject}`);
	await page.getByRole("button", { name: "Close composer" }).click();
});

test("/ focuses search and Cmd+K opens the command palette, which runs the chosen command", async ({ page }) => {
	const [subject] = await deliverMany(["Keys palette"]);
	await openInbox(page, subject);

	await page.keyboard.press("/");
	await expect(page.getByPlaceholder(/^Search mail/)).toBeFocused();
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	const palette = page.getByRole("dialog", { name: "Command palette" });
	await expect(async () => {
		if (!(await palette.isVisible())) await page.keyboard.press("ControlOrMeta+k");
		await expect(palette).toBeVisible({ timeout: 1000 });
	}).toPass();
	await page.getByRole("combobox", { name: "Search commands" }).fill("go to starred");
	await expect(palette.getByRole("option", { name: /Go to Starred/ })).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Enter");
	await expect(palette).toHaveCount(0);
	await expect(page).toHaveURL(/\/starred$/);
});

test("mail keys stay out of the search field, the composer and its buttons", async ({ page }) => {
	const [subject] = await deliverMany(["Keys typed"]);
	await openInbox(page, subject);
	await rowLink(page, subject).click();
	const heading = page.getByRole("heading", { level: 1, name: subject });
	await expect(heading).toBeVisible();
	const messageUrl = page.url();
	const composer = page.getByRole("button", { name: "Close composer" });
	const unchanged = async () => {
		await expect(page).toHaveURL(messageUrl);
		await expect(heading).toBeVisible();
	};

	const search = page.getByPlaceholder(/^Search mail/);
	await search.click();
	await page.keyboard.type("jkxe#af");
	await expect(search).toHaveValue("jkxe#af");
	await unchanged();
	await expect(composer).toHaveCount(0);
	await search.fill("");

	await page.getByRole("button", { name: "Compose" }).click();
	const composeSubject = page.getByLabel("Subject");
	await composeSubject.click();
	await page.keyboard.type("jkxe#af");
	await expect(composeSubject).toHaveValue("jkxe#af");
	const body = page.getByRole("textbox", { name: "Message body" });
	await expect(body).toHaveAttribute("contenteditable", "true");
	await body.click();
	await page.keyboard.type("jkxe#af");
	await expect(body).toContainText("jkxe#af");
	await unchanged();
	await expect(composer).toHaveCount(1);

	// A focused button in the composer does not pass `e` or `#` to the open message behind it.
	await page.getByRole("button", { name: "Bold (⌘B)" }).focus();
	await page.keyboard.press("e");
	await page.keyboard.press("#");
	// The reader's archive would navigate back to the list; give a wrongly fired shortcut time to do so.
	await page.waitForTimeout(1000);
	await unchanged();
	await composer.click();
});

test("the All mail and Unread toggles filter the list", async ({ page }) => {
	const [read, unread] = await deliverMany(["Keys tab read", "Keys tab unread"]);
	await openInbox(page, unread);
	await rowLink(page, read).click();
	await expect(page.getByRole("heading", { level: 1, name: read })).toBeVisible();
	await page.goto("/inbox");

	await page.getByRole("button", { name: "Unread", exact: true }).click();
	await expect(page.getByRole("button", { name: "Unread", exact: true })).toHaveAttribute("aria-pressed", "true");
	await expect(rowLink(page, unread)).toBeVisible();
	await expect(rowLink(page, read)).toHaveCount(0);
	await page.getByRole("button", { name: "All mail", exact: true }).click();
	await expect(rowLink(page, read)).toBeVisible();
});

test("the list and sidebar resize from the keyboard and keep their widths", async ({ page }) => {
	const [subject] = await deliverMany(["Keys resize"]);
	await openInbox(page, subject);
	const list = page.getByRole("main").locator("[data-density]");
	const before = (await list.boundingBox())!.width;

	await page.getByRole("separator", { name: "Resize message list" }).focus();
	for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowRight");
	await expect.poll(async () => (await list.boundingBox())!.width).toBeGreaterThan(before + 20);
	const widened = (await list.boundingBox())!.width;
	await expect
		.poll(() => page.evaluate(() => Number(localStorage.getItem("kite-column-width:message-list"))))
		.toBeGreaterThan(before);

	await page.reload();
	await expect(rowLink(page, subject)).toBeVisible();
	await expect.poll(async () => Math.abs((await list.boundingBox())!.width - widened)).toBeLessThan(3);

	// The sidebar panel collapses to its icon rail from its toggle, remembers that, and expands again.
	const sidebar = page.locator("#kite-sidebar-layout > [data-panel]").first();
	const expanded = (await sidebar.boundingBox())!.width;
	await page.getByRole("button", { name: "Collapse menu" }).click();
	await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
	await page.reload();
	await expect(page.getByRole("button", { name: "Expand menu" })).toBeVisible();
	await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
	await page.getByRole("button", { name: "Expand menu" }).click();
	await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - expanded)).toBeLessThan(3);
});
