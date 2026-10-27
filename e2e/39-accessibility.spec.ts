import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, signIn, uniqueToken } from "./support/helpers";

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

async function deliver(label: string) {
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Access Sender" <access@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
	});
	return { subject, message };
}

test("the skip link is the first tab stop and moves focus to the main content", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	await page.keyboard.press("Tab");
	const skip = page.getByRole("link", { name: "Skip to main content" });
	await expect(skip).toBeFocused();
	await expect(skip).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("main")).toBeFocused();
});

test("a message row is reachable by keyboard and Enter opens the message", async ({ page }) => {
	const { subject, message } = await deliver("Keyboard row");
	await page.goto("/inbox");
	const row = page.getByRole("list", { name: "Inbox" }).getByRole("listitem").filter({ hasText: subject });
	await expect(row).toHaveCount(1);
	await expect(row.getByRole("checkbox", { name: "Select message from Access Sender" })).toBeVisible();
	await expect(row.getByRole("button", { name: "Star", exact: true, pressed: false })).toBeAttached();
	await expect(row.getByText("Unread", { exact: true })).toBeAttached();

	await row.getByRole("checkbox").focus();
	// The star sits in the row's corner after the link, so the link is the next stop.
	await page.keyboard.press("Tab");
	const link = row.getByRole("link", { name: new RegExp(subject) });
	await expect(link).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/inbox/${message.id}$`));
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(link).toHaveAttribute("aria-current", "true");
});

test("the command palette and the shortcuts help keep focus inside and give it back", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	const opener = page.getByRole("button", { name: "Open account menu" });
	await opener.focus();

	await expect(async () => {
		if (!(await page.getByRole("dialog", { name: "Command palette" }).isVisible()))
			await page.keyboard.press("Control+k");
		await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible({ timeout: 1000 });
	}).toPass();
	const combobox = page.getByRole("combobox", { name: "Search commands" });
	await expect(combobox).toBeFocused();
	await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option").first()).toHaveAttribute(
		"aria-selected",
		"true",
	);
	const first = await combobox.getAttribute("aria-activedescendant");
	await page.keyboard.press("ArrowDown");
	await expect(combobox).not.toHaveAttribute("aria-activedescendant", first ?? "");
	await page.keyboard.press("Tab");
	await expect(combobox).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
	await expect(opener).toBeFocused();

	await page.keyboard.press("?");
	const help = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
	await expect(help).toBeVisible();
	await expect(help.getByRole("button", { name: "Close keyboard shortcuts" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(help.getByRole("button", { name: "Close keyboard shortcuts" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("Escape closes the account menu and leaves focus on its button", async ({ page }) => {
	await page.goto("/inbox");
	const button = page.getByRole("button", { name: "Open account menu" });
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await expect(button).toBeFocused();
});

test("the composer takes focus when it opens and gives it back when it closes", async ({ page }) => {
	await page.goto("/inbox");
	const compose = page.getByRole("button", { name: "Compose" });
	await compose.click();
	const composer = page.getByRole("region", { name: "Compose message" });
	await expect(composer).toBeVisible();
	await expect(composer.getByLabel("To")).toBeFocused();
	await composer.getByRole("button", { name: "Close composer" }).click();
	await expect(composer).toHaveCount(0);
	await expect(compose).toBeFocused();
});

test.describe("signed out", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("the sign-in page is titled", async ({ page }) => {
		await page.goto("/login");
		await expect(page).toHaveTitle(/^Sign in - /);
	});

	test("a failed sign-in is announced and tied to the fields", async ({ page }) => {
		await signIn(page, `nobody-${uniqueToken()}@example.com`, "not-the-password");
		const alert = page.getByRole("alert").filter({ hasText: "Invalid credentials" });
		await expect(alert).toBeVisible();
		await expect(alert).toHaveAttribute("id", "login-error");
		for (const field of [page.getByLabel("Email"), page.getByLabel("Password")]) {
			await expect(field).toHaveAttribute("aria-invalid", "true");
			await expect(field).toHaveAttribute("aria-describedby", "login-error");
		}
	});
});

test("a settings form announces its result as a status message", async ({ page }) => {
	await page.goto("/settings/security");
	await page.getByLabel("Current password").fill("anything-at-all");
	await page.getByLabel("New password", { exact: true }).fill("first-password-1");
	await page.getByLabel("Confirm new password").fill("second-password-2");
	await page.getByRole("button", { name: "Change password" }).click();
	await expect(page.getByRole("status").filter({ hasText: "New passwords do not match" })).toBeVisible();
});

test("the startup overlay is announced only while it is showing", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	const overlay = page.locator("[data-loading-overlay]");
	await expect(overlay).toHaveAttribute("aria-hidden", "true");
	await expect(overlay).not.toHaveAttribute("role", "status");
	await expect(overlay.locator("img")).toHaveAttribute("alt", "");
});

test("pages are titled after themselves, also after a client-side navigation", async ({ page }) => {
	await page.goto("/settings/account");
	await expect(page).toHaveTitle(/^My account - /);
	await page.getByRole("navigation", { name: "Security" }).getByRole("link", { name: "Security", exact: true }).click();
	await expect(page).toHaveURL(/\/settings\/security$/);
	await expect(page).toHaveTitle(/^Security - /);
	await page.goto("/domains");
	await expect(page).toHaveTitle(/^Domains - /);
	await page.goto("/inbox");
	await expect(page).toHaveTitle(/^Inbox/);
});

test("each page has one h1, and the folder list keeps a heading while a message is open", async ({ page }) => {
	for (const path of [
		"/inbox",
		"/sent",
		"/settings/account",
		"/settings/inbox",
		"/settings/rules",
		"/settings/export",
		"/admin",
		"/domains",
	]) {
		await page.goto(path);
		await expect(page.getByRole("main")).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1);
	}
	await page.goto("/inbox");
	await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toHaveCount(1);
	const { subject, message } = await deliver("Heading check");
	await page.goto(`/inbox/${message.id}`);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(subject);
	await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toHaveCount(1);
});

test("navigation landmarks have distinct names", async ({ page }) => {
	for (const path of ["/inbox", "/settings/account", "/domains"]) {
		await page.goto(path);
		await expect(page.getByRole("main")).toBeVisible();
		const names = await page
			.getByRole("navigation")
			.evaluateAll((navs) => navs.map((nav) => nav.getAttribute("aria-label") ?? ""));
		expect(names.length, path).toBeGreaterThan(0);
		expect(
			names.filter((name) => !name),
			path,
		).toEqual([]);
		expect(new Set(names).size, path).toBe(names.length);
	}
});

/** The WCAG contrast ratio between an element's text colour and its own background. */
async function ownContrast(target: Locator) {
	return target.evaluate((element) => {
		const context = document.createElement("canvas").getContext("2d")!;
		const rgb = (color: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		};
		const luminance = (value: number[]) => {
			const [r, g, b] = value.map((channel) => {
				const c = channel / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const style = getComputedStyle(element);
		const [high, low] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((x, y) => y - x);
		return (high + 0.05) / (low + 0.05);
	});
}

test("secondary text and the highlighted command meet AA contrast in Kite, Classic and dark mode", async ({ page }) => {
	for (const style of [
		{ theme: "light", classic: false },
		{ theme: "light", classic: true },
		{ theme: "dark", classic: false },
		{ theme: "dark", classic: true },
	]) {
		const label = `${style.classic ? "classic" : "kite"} ${style.theme}`;
		await page.addInitScript(({ theme, classic }) => {
			localStorage.setItem("kite-theme", theme);
			if (classic) localStorage.setItem("kite-style", "classic");
			else localStorage.removeItem("kite-style");
		}, style);
		await page.goto("/inbox");
		await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
		const palette = page.getByRole("dialog", { name: "Command palette" });
		await expect(async () => {
			if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
			await expect(palette).toBeVisible({ timeout: 1000 });
		}).toPass();
		const footer = palette.locator("div.bg-neutral-50.text-neutral-500");
		expect(await ownContrast(footer), `${label} palette footer`).toBeGreaterThanOrEqual(4.5);
		const active = palette.locator('[role="option"][aria-selected="true"]');
		expect(await ownContrast(active), `${label} highlighted command`).toBeGreaterThanOrEqual(4.5);
		await page.keyboard.press("Escape");
		await expect(palette).toHaveCount(0);
	}
});

test("the calendar event editor keeps focus inside, closes on Escape and gives focus back", async ({ page }) => {
	await page.goto("/calendar");
	const opener = page.getByRole("button", { name: "New event" });
	await opener.click();
	const editor = page.getByRole("dialog", { name: "Create event" });
	await expect(editor).toBeVisible();
	await expect(editor).toHaveAttribute("aria-modal", "true");
	await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	for (let step = 0; step < 25; step += 1) await page.keyboard.press("Tab");
	await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("Escape closes the mobile menu drawer and returns focus to the menu button", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/inbox");
	const button = page.getByRole("button", { name: "Open menu" });
	await button.click();
	// The drawer is a modal sheet, which hides the page behind it, menu button included, from assistive technology.
	const sheet = page.getByRole("dialog", { name: "Menu" });
	await expect(sheet.getByRole("link", { name: /^Inbox\b/ })).toBeVisible();
	await expect(page.locator("[data-mobile-menu]")).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await expect(button).toBeFocused();
});

test("wide admin tables declare column headers and scroll by keyboard, and routing hints are buttons", async ({
	page,
}) => {
	for (const [path, name] of [
		["/activity", "Activity"],
		["/ai-usage", "AI usage"],
	] as const) {
		await page.goto(path);
		const region = page.getByRole("region", { name, exact: true });
		await expect(region).toHaveAttribute("tabindex", "0");
		const headers = region.locator("th");
		await expect(headers.first()).toBeVisible();
		await expect(region.locator('th:not([scope="col"])')).toHaveCount(0);
		await region.focus();
		await expect(region).toBeFocused();
	}

	await page.goto("/routing");
	const hint = page.getByRole("button", {
		name: "Evaluated before delivery. Matching mail is rejected at the edge.",
	});
	await hint.focus();
	await expect(page.getByRole("tooltip")).toHaveText(
		"Evaluated before delivery. Matching mail is rejected at the edge.",
	);
});
