import { expect, test, type Locator, type Page } from "@playwright/test";
import { DOMAIN, RELEASE_VERSION, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, signIn, uniqueToken } from "./support/helpers";
import { contrastBetween } from "./support/contrast";
import { chooseOption, expectSelectValue, readOptions } from "./support/select";

const PENDING_API = "/api/migrations/pending";
const APPLY_API = "/api/admin/migrations";
const USER_PASSWORD = "updates-user-password-123";
/** The kite that lifts off the "Database updated" notice (migrations-applied-notice.tsx). */
const NOTICE_FLIGHT = "[data-applied-notice-flight]";

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
	// In the sidebar: the loading screen's own "Loading Kite v…" line can still be in the tree while the app fades in.
	await expect(
		page.locator("aside").getByText(new RegExp(`Kite v${RELEASE_VERSION.replaceAll(".", "\\.")}`)),
	).toBeVisible();

	await updated.click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`Kite v${RELEASE_VERSION}`);
	// Fragments waiting for a release read "Unreleased changes"; right after a release the newest one is the current build.
	await expect(dialog).toContainText(
		new RegExp(`Unreleased changes|${RELEASE_VERSION.replaceAll(".", "\\.")} · \\d{4}-\\d{2}-\\d{2} · Current`),
	);
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

const IMAGES_KEY = "kite-changelog-images";
/** The release whose notes carry the command center screenshots (public/changelog/). */
const SCREENSHOT_RELEASE = "2026.11.01.2";

async function openChangelogRelease(page: Page, name: string) {
	await openInbox(page);
	await page.getByRole("button", { name: /^Updated / }).click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await showRelease(dialog, name);
	return dialog;
}

test("a release note shows its screenshots as thumbnails that open a larger view", async ({ page }) => {
	const dialog = await openChangelogRelease(page, SCREENSHOT_RELEASE);
	const light = dialog.getByRole("button", { name: /command center in light mode/i });
	const dark = dialog.getByRole("button", { name: /same command center in dark mode/i });
	await expect(light).toBeVisible();
	await expect(dark).toBeVisible();
	// The thumbnails are lazy static assets of this origin, and they really load.
	const image = light.locator("img");
	await expect(image).toHaveAttribute("loading", "lazy");
	await expect(image).toHaveAttribute("src", /^\/changelog\/[\w.-]+\.webp$/);
	await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);

	await light.focus();
	await page.keyboard.press("Enter");
	const viewer = page.getByRole("dialog", { name: /command center in light mode/i });
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole("img", { name: /command center in light mode/i })).toBeVisible();
	await expect(viewer).toContainText("1 / 2");

	// The arrow keys step between the release's screenshots, in both directions, and wrap around.
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("dialog", { name: /same command center in dark mode/i })).toBeVisible();
	await expect(page.getByRole("dialog", { name: /same command center in dark mode/i })).toContainText("2 / 2");
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("dialog", { name: /command center in light mode/i })).toContainText("1 / 2");
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByRole("dialog", { name: /same command center in dark mode/i })).toBeVisible();

	// Actual size swaps the fit-to-screen view for the image's own pixels, scrolled inside the viewer.
	const stage = page.getByTestId("changelog-lightbox-stage");
	await page.getByRole("button", { name: "Actual size" }).click();
	await expect(page.getByRole("button", { name: "Fit to screen" })).toBeVisible();
	await expect.poll(() => stage.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
	await page.getByRole("button", { name: "Fit to screen" }).click();

	// Escape closes only the viewer; the focus lands on the thumbnail that was last shown, and the notes stay open.
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: /same command center in dark mode/i })).toBeHidden();
	await expect(dialog).toBeVisible();
	await expect(dark).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("a click on a thumbnail opens the larger view, and Close brings the focus back", async ({ page }) => {
	const dialog = await openChangelogRelease(page, SCREENSHOT_RELEASE);
	const light = dialog.getByRole("button", { name: /command center in light mode/i });
	await light.click();
	const viewer = page.getByRole("dialog", { name: /command center in light mode/i });
	await expect(viewer).toBeVisible();
	await viewer.getByRole("button", { name: "Close" }).click();
	await expect(viewer).toBeHidden();
	await expect(light).toBeFocused();
});

test("Show images turns the screenshots off, and the choice outlives a reload", async ({ page }) => {
	const dialog = await openChangelogRelease(page, SCREENSHOT_RELEASE);
	const toggle = dialog.getByRole("switch", { name: "Show images" });
	// On by default.
	await expect(toggle).toBeChecked();
	await expect(dialog.getByRole("button", { name: /command center in light mode/i })).toBeVisible();

	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(dialog.locator("img")).toHaveCount(0);
	// The notes themselves stay.
	await expect(dialog).toContainText("laid out as cards again");
	expect(await page.evaluate((key) => localStorage.getItem(key), IMAGES_KEY)).toBe("false");

	await page.reload();
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /^Updated / }).click();
	const reopened = page.getByRole("dialog", { name: /What's new in Kite/ });
	await showRelease(reopened, SCREENSHOT_RELEASE);
	await expect(reopened.getByRole("switch", { name: "Show images" })).not.toBeChecked();
	await expect(reopened.locator("img")).toHaveCount(0);

	await reopened.getByRole("switch", { name: "Show images" }).click();
	await expect(reopened.getByRole("button", { name: /command center in light mode/i })).toBeVisible();
	expect(await page.evaluate((key) => localStorage.getItem(key), IMAGES_KEY)).toBe("true");
});

test("on a phone the thumbnails and the larger view fit the screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open menu" }).click();
	await page.getByRole("button", { name: /^Updated / }).click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await chooseOption(dialog.getByRole("combobox", { name: "Jump to release" }), SCREENSHOT_RELEASE);
	const light = dialog.getByRole("button", { name: /command center in light mode/i });
	await light.scrollIntoViewIfNeeded();
	await expect(light).toBeVisible();
	await light.click();
	const viewer = page.getByRole("dialog", { name: /command center in light mode/i });
	await expect(viewer).toBeVisible();
	const box = await viewer.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(box!.y + box!.height).toBeLessThanOrEqual(844);
});

test("a release note that links to a setting opens that page in the app", async ({ page }) => {
	await openInbox(page);
	await page.getByRole("button", { name: /^Updated / }).click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await showRelease(dialog, "2026.10.13.0");
	// Several notes may link to the same setting; any of them must behave the same. This release's notes predate the
	// Notifications page, so the link still names the Inbox page, which opens like any app page.
	const settingLink = dialog.getByRole("link", { name: "Settings → Inbox → Notifications" }).first();
	await expect(settingLink).toHaveAttribute("href", "/settings/inbox");
	// An app page opens in this tab, unlike outside links.
	await expect(settingLink).not.toHaveAttribute("target", "_blank");
	await settingLink.click();
	await expect(page).toHaveURL(/\/settings\/inbox$/);
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("heading", { level: 1, name: "Inbox settings" })).toBeVisible();
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
	// The compact result leaves at once through its close button, the same way it leaves on its own.
	await notice.getByRole("button", { name: "Dismiss" }).click();
	await expect(page.locator(NOTICE_FLIGHT)).toBeAttached();
	await expect(notice).toHaveCount(0);
	await expect(page.locator(NOTICE_FLIGHT)).toHaveCount(0);
});

test.describe("the Database updated notice", () => {
	const NAMES = ["0001_add_column.sql", "0002_add_table.sql"];

	/** Answers the status and the apply request; a failing run answers 500 and leaves everything pending. */
	async function routeApply(page: Page, { fail = false } = {}) {
		let pending = NAMES.length;
		await page.route(`**${PENDING_API}`, (route) => route.fulfill({ json: { pending, names: NAMES } }));
		await page.route(`**${APPLY_API}`, async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			if (fail) return route.fulfill({ status: 500, json: { error: "The database is not reachable right now." } });
			pending = 0;
			await route.fulfill({ json: { ready: true, pending: [], unknown: [], applied: NAMES, backupId: "bak_e2e" } });
		});
	}

	/** Records which parts of the exit were ever in the page, since the fade is over before a locator could see it. */
	async function watchExit(page: Page) {
		await page.addInitScript(() => {
			const seen = new Set<string>();
			(window as unknown as { __kiteNoticeSeen: Set<string> }).__kiteNoticeSeen = seen;
			new MutationObserver(() => {
				if (document.querySelector("[data-applied-notice-flight]")) seen.add("kite");
				if (document.querySelector(".applied-notice-fade")) seen.add("fade");
				if (document.querySelector(".applied-notice-leave")) seen.add("leave");
				// An init script runs before the document has an element, so the document itself is observed.
			}).observe(document, { childList: true, subtree: true, attributes: true });
		});
		return () =>
			page.evaluate(() => [...(window as unknown as { __kiteNoticeSeen: Set<string> }).__kiteNoticeSeen].sort());
	}

	/** Applies the updates from the empty reading pane with the page's timers under the test's control. */
	async function applyWithClock(page: Page) {
		await routeApply(page);
		await page.clock.install();
		await openInbox(page);
		const notice = page.getByRole("region", { name: "Database updates" });
		await notice.getByRole("button", { name: "Apply now" }).click();
		await expect(notice).toContainText("Database updated");
		await expect(notice).toContainText("2 database updates applied. A safety backup was saved first.");
		return notice;
	}

	test("stays readable for eight seconds, then the kite takes it away and it does not come back", async ({ page }) => {
		const seen = await watchExit(page);
		const notice = await applyWithClock(page);
		await page.clock.fastForward(7_000);
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute("data-applied-notice", "shown");
		await page.clock.fastForward(1_100);
		// The box folds while the kite lifts off; both are gone once the flight has ended.
		await expect(notice).toHaveAttribute("data-applied-notice", "leaving");
		await expect(page.locator(NOTICE_FLIGHT)).toBeAttached();
		await expect(notice).toHaveCount(0);
		await expect(page.locator(NOTICE_FLIGHT)).toHaveCount(0);
		expect(await seen()).toEqual(["kite", "leave"]);
		await page.reload();
		await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("region", { name: "Database updates" })).toHaveCount(0);
	});

	test("waits while the pointer or the focus is on it", async ({ page }) => {
		const notice = await applyWithClock(page);
		await page.clock.fastForward(5_000);
		await notice.hover();
		await page.clock.fastForward(30_000);
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute("data-applied-notice", "shown");
		// The keyboard focus holds it too, with the pointer gone.
		await notice.getByRole("button", { name: "Dismiss" }).focus();
		await page.mouse.move(5, 5);
		await page.clock.fastForward(30_000);
		await expect(notice).toHaveAttribute("data-applied-notice", "shown");
		await page.getByRole("button", { name: "Compose new email", exact: true }).focus();
		// Once it is free again it stays at least two more seconds, so it never vanishes under a leaving pointer.
		await page.clock.fastForward(1_900);
		await expect(notice).toHaveAttribute("data-applied-notice", "shown");
		await page.clock.fastForward(200);
		await expect(notice).toHaveCount(0);
	});

	test("dismissed with the keyboard, it hands the focus to the element next to it", async ({ page }) => {
		const notice = await applyWithClock(page);
		await notice.getByRole("button", { name: "Dismiss" }).focus();
		await page.keyboard.press("Enter");
		await expect(notice).toHaveAttribute("data-applied-notice", "leaving");
		const focused = () =>
			page.evaluate(() => {
				const active = document.activeElement;
				if (!active || active === document.body) return "page";
				return active.closest('[aria-label="Database updates"]') ? "notice" : "neighbour";
			});
		expect(await focused()).toBe("neighbour");
		await page.clock.fastForward(2_000);
		await expect(notice).toHaveCount(0);
		expect(await focused()).toBe("neighbour");
	});

	test("with reduced motion it fades without the kite", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const seen = await watchExit(page);
		const notice = await applyWithClock(page);
		await page.clock.fastForward(8_100);
		await expect(notice).toHaveCount(0);
		expect(await seen()).toEqual(["fade"]);
	});

	test("pending updates and a failed run never leave on their own", async ({ page }) => {
		await routeApply(page, { fail: true });
		await page.clock.install();
		await openInbox(page);
		const notice = page.getByRole("region", { name: "Database updates" });
		await expect(notice).toContainText("still needs 2 updates");
		await page.clock.fastForward(60_000);
		await expect(notice).toContainText("still needs 2 updates");

		await notice.getByRole("button", { name: "Apply now" }).click();
		await expect(notice.getByRole("alert")).toContainText("The database is not reachable right now.");
		await page.clock.fastForward(60_000);
		await expect(notice).toBeVisible();
		await expect(notice.getByRole("alert")).toContainText("The database is not reachable right now.");
		await expect(notice).toContainText("still needs 2 updates");
		await expect(notice.getByRole("button", { name: "Apply now" })).toBeVisible();
		await expect(notice.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
		await expect(page.locator(NOTICE_FLIGHT)).toHaveCount(0);
	});
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
