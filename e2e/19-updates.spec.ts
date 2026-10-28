import { expect, test, type Locator, type Page } from "@playwright/test";
import { DOMAIN, RELEASE_VERSION, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, signIn, uniqueToken } from "./support/helpers";
import { contrastBetween } from "./support/contrast";
import { chooseOption, expectSelectValue, readOptions } from "./support/select";

const PENDING_API = "/api/migrations/pending";
const APPLY_API = "/api/admin/migrations";
const USER_PASSWORD = "updates-user-password-123";

async function openInbox(page: Page) {
	const status = page.waitForResponse((response) => response.url().includes(PENDING_API));
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	await status;
}

/** Older releases are drawn only once they are needed, so a test that reads one opens it from the list first. */
async function showRelease(dialog: Locator, name: string) {
	await dialog
		.getByRole("navigation", { name: "Releases" })
		.getByRole("button", { name: new RegExp(`^${name}`) })
		.click();
	await expect(dialog.getByRole("heading", { name, exact: true })).toBeFocused();
}

test("the sidebar footer shows when this build was made and opens the release notes", async ({ page }) => {
	await openInbox(page);

	const updated = page.getByRole("button", { name: /^Updated / });
	await expect(updated).toBeVisible();
	// The label is filled in after mount, in the browser's locale and time zone.
	await expect(updated).not.toHaveText(/…/);
	await expect(page.getByRole("link", { name: "Source code" })).toBeVisible();
	await expect(page.getByText(new RegExp(`Kite v${RELEASE_VERSION.replaceAll(".", "\\.")}`))).toBeVisible();

	await updated.click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`Kite v${RELEASE_VERSION}`);
	await expect(dialog).toContainText("Unreleased changes");
	await showRelease(dialog, "2026.10.12.0");
	await expect(dialog).toContainText("The sidebar footer shows when this build was made");
	// Inline code and links from the changelog are rendered, not shown as markdown.
	await expect(dialog.locator("code", { hasText: "AUTO_APPLY_MIGRATIONS=1" })).toHaveCount(1);
	await expect(dialog.getByRole("link", { name: "Deployment" })).toHaveAttribute(
		"href",
		/https:\/\/github\.com\/.+\/blob\/main\/docs\/deployment\.md/,
	);
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
});

test("a release note that links to a setting opens that page in the app", async ({ page }) => {
	await openInbox(page);
	await page.getByRole("button", { name: /^Updated / }).click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await showRelease(dialog, "2026.10.13.0");
	// Several notes may link to the same setting; any of them must behave the same.
	const settingLink = dialog.getByRole("link", { name: "Settings → Inbox → Notifications" }).first();
	await expect(settingLink).toHaveAttribute("href", "/settings/inbox");
	// An app page opens in this tab, unlike outside links.
	await expect(settingLink).not.toHaveAttribute("target", "_blank");
	await settingLink.click();
	await expect(page).toHaveURL(/\/settings\/inbox$/);
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("button", { name: "Send test notification" })).toBeVisible();
});

test("no database banner while the schema is up to date", async ({ page }) => {
	await openInbox(page);
	await expect(page.getByRole("region", { name: "Database updates" })).toHaveCount(0);
});

test("the primary admin applies pending database updates from the banner", async ({ page }) => {
	let pending = 2;
	const posts: string[] = [];
	await page.route(`**${PENDING_API}`, async (route) => {
		await route.fulfill({ json: { pending, names: ["0001_add_column.sql", "0002_add_table.sql"] } });
	});
	await page.route(`**${APPLY_API}`, async (route) => {
		posts.push(route.request().method());
		if (route.request().method() !== "POST") return route.continue();
		pending = 0;
		await route.fulfill({
			json: {
				ready: true,
				pending: [],
				unknown: [],
				applied: ["0001_add_column.sql", "0002_add_table.sql"],
				backupId: "bak_e2e",
			},
		});
	});

	await openInbox(page);
	const banner = page.getByRole("region", { name: "Database updates" });
	await expect(banner).toBeVisible();
	// With nothing open the notice sits in the empty reading pane, and there is no second copy above the list.
	await expect(page.getByTestId("reading-pane-empty").getByRole("region", { name: "Database updates" })).toBeVisible();
	await expect(banner).toHaveCount(1);
	await expect(banner).toContainText("Kite was updated, but the database still needs 2 updates");
	await expect(banner).toContainText("new email may not appear and some pages may fail");
	await expect(banner).toContainText("0001_add_column.sql");
	await expect(banner.getByRole("link", { name: "Admin overview" })).toHaveAttribute("href", "/admin");

	await banner.getByRole("button", { name: "Apply now" }).click();
	await expect(banner).toContainText("Database updated");
	await expect(banner).toContainText("2 database updates applied. A safety backup was saved first.");
	// The warning is gone once the status reports nothing pending, and only one POST was sent.
	await expect(banner).not.toContainText("Kite was updated");
	expect(posts).toEqual(["POST"]);
});

test("a member is told to ask an administrator and gets no Apply button", async ({ browser }) => {
	const api = await apiContext(STORAGE_STATE);
	const domains = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const domain = domains.domains.find((entry) => entry.hostname === DOMAIN);
	expect(domain).toBeDefined();
	const username = uniqueToken("updates");
	const created = await api.post("/api/accounts", {
		data: { username, domainId: domain!.id, password: USER_PASSWORD, role: "user" },
	});
	expect(created.ok(), await created.text()).toBe(true);
	await api.dispose();

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.route(`**${PENDING_API}`, (route) => route.fulfill({ json: { pending: 1 } }));
	await signIn(page, `${username}@${DOMAIN}`, USER_PASSWORD);
	const banner = page.getByRole("region", { name: "Database updates" });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("still needs 1 update");
	await expect(banner).toContainText("Ask an administrator to apply them.");
	await expect(banner.getByRole("button", { name: "Apply now" })).toHaveCount(0);
	await expect(banner.getByRole("link", { name: "Admin overview" })).toHaveCount(0);
	await context.close();
});

test("with a message open the notice moves to a compact notice in the sidebar", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Updates notice ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Notice Sender" <notice@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Notice body.",
	});
	await api.dispose();

	let pending = 1;
	await page.route(`**${PENDING_API}`, (route) => route.fulfill({ json: { pending, names: ["0001_add_column.sql"] } }));
	await page.route(`**${APPLY_API}`, async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		pending = 0;
		await route.fulfill({ json: { ready: true, pending: [], unknown: [], applied: ["0001_add_column.sql"] } });
	});

	await openInbox(page);
	const notice = page.getByRole("region", { name: "Database updates" });
	await expect(page.getByTestId("reading-pane-empty").getByRole("region", { name: "Database updates" })).toBeVisible();

	await openMessage(page, subject);
	await expect(page.getByTestId("reading-pane-empty")).toHaveCount(0);
	await expect(notice).toHaveCount(1);
	await expect(
		page.getByRole("navigation", { name: "Kite" }).getByRole("region", { name: "Database updates" }),
	).toHaveCount(1);
	await expect(notice).toContainText("still needs 1 update");
	await expect(notice).toHaveAttribute("title", "0001_add_column.sql");
	// Compact: a title, one short line and the button, not a bar across the page.
	expect((await notice.boundingBox())!.height).toBeLessThan(120);

	await notice.getByRole("button", { name: "Apply now" }).click();
	await expect(notice).toContainText("1 database update applied.");
	await expect(notice).not.toContainText("Kite was updated");
});

test.describe("the release list in the What's new dialog", () => {
	async function openReleaseNotes(page: Page) {
		await openInbox(page);
		await page.getByRole("button", { name: /^Updated / }).click();
		const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
		await expect(dialog).toBeVisible();
		return dialog;
	}

	test("lists the releases, jumps to one and follows the scroll", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const dialog = await openReleaseNotes(page);
		const nav = dialog.getByRole("navigation", { name: "Releases" });
		const items = nav.getByRole("button");
		// "Unreleased" is listed only while changelog fragments wait for a release; right after one, the newest release leads.
		const newest = items.first();
		const newestName = ((await newest.getAttribute("data-release-nav")) ?? "").trim();
		expect(["Unreleased", RELEASE_VERSION]).toContain(newestName);
		await expect(newest).toHaveAttribute("aria-current", "location");
		const current = nav.getByRole("button", { name: new RegExp(`^${RELEASE_VERSION.replaceAll(".", "\\.")}`) });
		await expect(current).toContainText("Current");
		await expect(current).toContainText(/\d{4}-\d{2}-\d{2}/);
		expect(await items.count()).toBeGreaterThan(5);

		// Releases far down are not drawn until they are needed...
		const oldest = items.last();
		const oldestName = ((await oldest.getAttribute("data-release-nav")) ?? "").trim();
		expect(oldestName).not.toBe("");
		const oldestHeading = dialog.getByRole("heading", { name: oldestName, exact: true });
		await expect(oldestHeading).toHaveCount(0);

		// ...and a click draws them, scrolls there and moves focus to the heading.
		await oldest.click();
		await expect(oldestHeading).toBeVisible();
		await expect(oldestHeading).toBeFocused();
		await expect(oldest).toHaveAttribute("aria-current", "location");
		await expect(newest).not.toHaveAttribute("aria-current", "location");
		const notes = dialog.getByTestId("changelog-notes");
		await expect
			.poll(async () => {
				const pane = (await notes.boundingBox())!;
				const heading = (await oldestHeading.boundingBox())!;
				return heading.y >= pane.y - 1 && heading.y + heading.height <= pane.y + pane.height + 1;
			})
			.toBe(true);

		// Scrolling the notes by hand moves the highlight back.
		await notes.evaluate((element) => element.scrollTo({ top: 0 }));
		await expect(newest).toHaveAttribute("aria-current", "location", { timeout: 5000 });
		await expect(oldest).not.toHaveAttribute("aria-current", "location");

		await current.click();
		await expect(dialog.getByRole("heading", { name: RELEASE_VERSION, exact: true })).toBeFocused();
		await expect(current).toHaveAttribute("aria-current", "location");
	});

	test("the arrow keys move between releases", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const dialog = await openReleaseNotes(page);
		const items = dialog.getByRole("navigation", { name: "Releases" }).getByRole("button");
		await items.first().focus();
		await page.keyboard.press("ArrowDown");
		await expect(items.nth(1)).toBeFocused();
		await page.keyboard.press("ArrowUp");
		await expect(items.first()).toBeFocused();
		await page.keyboard.press("End");
		await expect(items.last()).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(items.last()).toHaveAttribute("aria-current", "location");
	});

	test("on a phone the list is a menu at the top", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 800 });
		await page.goto("/inbox");
		// On a phone the sidebar, and its footer with the version line, is a sheet behind the menu button.
		await page.getByRole("button", { name: "Open menu" }).click();
		await page.getByRole("button", { name: /^Updated / }).click();
		const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("navigation", { name: "Releases" })).toBeHidden();
		const menu = dialog.getByRole("combobox", { name: "Jump to release" });
		await expect(menu).toBeVisible();
		// Choosing the release the menu already shows changes nothing, so pick one that is not selected: the current
		// release, or the one before it when the current one leads the list (no "Unreleased" right after a release).
		const options = await readOptions(menu);
		const selected = await menu.getAttribute("data-value");
		const target =
			selected === RELEASE_VERSION ? options.find((option) => option.value !== selected)!.value : RELEASE_VERSION;
		await chooseOption(menu, target);
		const heading = dialog.getByRole("heading", { name: target, exact: true });
		await expect(heading).toBeFocused();
		await expectSelectValue(menu, target);
		await expect(dialog.getByTestId("changelog-notes")).toBeVisible();
		const box = (await dialog.boundingBox())!;
		expect(box.width).toBeLessThanOrEqual(390);
	});

	for (const theme of ["light", "dark"]) {
		test(`the list is readable in the ${theme} theme`, async ({ page }) => {
			await page.addInitScript((value) => {
				localStorage.setItem("kite-style", "kite");
				localStorage.setItem("kite-theme", value);
			}, theme);
			await page.setViewportSize({ width: 1280, height: 900 });
			const dialog = await openReleaseNotes(page);
			await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);
			const nav = dialog.getByRole("navigation", { name: "Releases" });
			const items = nav.getByRole("button");
			const active = items.first();
			const inactive = items.nth(1);
			const current = nav.getByRole("button", { name: new RegExp(`^${RELEASE_VERSION.replaceAll(".", "\\.")}`) });
			expect(await contrastBetween(active, active)).toBeGreaterThan(4.5);
			expect(await contrastBetween(inactive, dialog)).toBeGreaterThan(4.5);
			expect(await contrastBetween(current.getByText("Current"), dialog)).toBeGreaterThan(4.5);
			expect(await contrastBetween(inactive.locator("span").last(), dialog)).toBeGreaterThan(4.5);
			await expect(dialog.getByTestId("changelog-notes")).toBeVisible();
		});
	}
});
