import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// In dark mode Kite adapts mail that brings its own colours: mail with a background is rendered light and inverted,
// mail with only text colours (the reader drops `bgcolor`) keeps the theme's canvas. The small "Original colours"
// button above the body shows the sender's own colours instead, in every reading layout and at every width.

const DESIGNED = `<table width="100%" bgcolor="#ffffff"><tr><td style="background-color:#ffffff;color:#222222">Designed mail body</td></tr></table>`;
// bgcolor does not survive the reader's sanitizer, so this arrives with text colours only.
const COLOURS_ONLY = `<table width="100%" bgcolor="#f4f4f4"><tr><td><p style="color:#333333">Colours only mail body</p></td></tr></table>`;

const ids: Record<"designed" | "coloursOnly" | "plain", string> = { designed: "", coloursOnly: "", plain: "" };
const subjects = { designed: "", coloursOnly: "", plain: "" };

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	for (const [key, label, html] of [
		["designed", "Designed", DESIGNED],
		["coloursOnly", "Colours only", COLOURS_ONLY],
		["plain", "Plain", "<p>Plain mail body</p>"],
	] as const) {
		subjects[key] = `${label} ${token}`;
		const stored = await deliverInbound(api, {
			from: `"${label} Sender" <${key.toLowerCase()}@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: subjects[key],
			html,
		});
		ids[key] = stored.id;
	}
	await api.dispose();
});

async function open(page: Page, theme: "dark" | "light", pane: "none" | "right" | "below", id: string) {
	await page.addInitScript(
		([themeValue, paneValue]) => {
			localStorage.setItem("kite-theme", themeValue);
			localStorage.setItem("kite-reading-pane", paneValue);
		},
		[theme, pane],
	);
	await page.goto(`/inbox/${id}`);
	await expect(page.getByTitle("Message body")).toBeVisible();
}

function html(page: Page) {
	return page.getByTitle("Message body").contentFrame().locator("html");
}

async function expectButtonAboveBody(page: Page) {
	const button = (await page.getByRole("button", { name: "Original colours" }).boundingBox())!;
	const frame = (await page.getByTitle("Message body").boundingBox())!;
	// Small, above the body and at its right edge.
	expect(button.y + button.height).toBeLessThanOrEqual(frame.y + 1);
	expect(button.x + button.width).toBeGreaterThan(frame.x + frame.width - 120);
	expect(button.height).toBeLessThan(40);
}

/** Switches to the sender's colours with the keyboard and back, checking the button's label and pressed state. */
async function toggleThroughKeyboard(page: Page, adapted: () => Promise<void>, original: () => Promise<void>) {
	const toggle = page.getByRole("button", { name: "Original colours" });
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await adapted();
	await expectButtonAboveBody(page);
	await toggle.focus();
	await page.keyboard.press("Enter");
	const back = page.getByRole("button", { name: "Dark colours" });
	await expect(back).toHaveAttribute("aria-pressed", "true");
	await original();
	await back.focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("button", { name: "Original colours" })).toHaveAttribute("aria-pressed", "false");
	await adapted();
}

const LAYOUTS = [
	["split view, right of inbox", 1440, 900, "right"],
	["split view, below inbox", 1440, 900, "below"],
	["no split", 1440, 900, "none"],
	["tablet", 820, 1100, "right"],
	["phone", 390, 844, "right"],
] as const;

for (const [label, width, height, pane] of LAYOUTS) {
	test(`dark mode, mail with a background: Original colours toggles the frame (${label})`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await open(page, "dark", pane, ids.designed);
		await toggleThroughKeyboard(
			page,
			() => expect(html(page)).toHaveCSS("filter", /invert/),
			() => expect(html(page)).toHaveCSS("filter", "none"),
		);
	});

	test(`dark mode, mail with only text colours: Original colours toggles the frame (${label})`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await open(page, "dark", pane, ids.coloursOnly);
		await toggleThroughKeyboard(
			page,
			async () => {
				await expect(html(page)).toHaveCSS("color-scheme", "dark");
				await expect(html(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			},
			async () => {
				await expect(html(page)).toHaveCSS("color-scheme", "light");
				await expect(html(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
			},
		);
	});
}

test("the button is reached from the list in the split view too", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => {
		localStorage.setItem("kite-theme", "dark");
		localStorage.setItem("kite-reading-pane", "right");
	});
	await page.goto("/inbox");
	await page.getByRole("main").getByText(subjects.designed, { exact: true }).first().click();
	await expect(page.getByRole("button", { name: "Original colours" })).toBeVisible();
});

test("conversation: every adapted message in the thread has its own button", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	await deliverInbound(api, {
		from: `"Thread Starter" <starter@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Thread ${token}`,
		html: DESIGNED.replace("Designed mail body", "First designed message"),
		messageId: originalId,
	});
	const reply = await deliverInbound(api, {
		from: `"Thread Starter" <starter@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Thread ${token}`,
		html: DESIGNED.replace("Designed mail body", "Second designed message"),
		inReplyTo: originalId,
	});
	await api.dispose();
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", reply.id);
	const earlier = page.getByRole("region", { name: "Earlier messages in this conversation" });
	await earlier.getByRole("button", { name: /Thread Starter/ }).click();
	await expect(earlier.locator("iframe").contentFrame().getByText("First designed message")).toBeAttached();
	await expect(page.getByRole("button", { name: "Original colours" })).toHaveCount(2);
	await expect(earlier.getByRole("button", { name: "Original colours" })).toBeVisible();
});

test("plain mail has nothing to adapt, so there is no button", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", ids.plain);
	await expect(page.getByRole("button", { name: /Original colours|Dark colours/ })).toHaveCount(0);
});

test("light mode has no button, even for mail with its own colours", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const id of [ids.designed, ids.coloursOnly]) {
		await open(page, "light", "right", id);
		await expect(page.getByRole("button", { name: /Original colours|Dark colours/ })).toHaveCount(0);
	}
});
