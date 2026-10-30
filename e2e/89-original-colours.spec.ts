import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// In dark mode Kite adapts mail that brings its own colours: it is rendered light and inverted, whether it paints a
// background or only sets text colours (the reader drops `bgcolor`). The small "Original colours" button above the
// body (a fixed label with a pressed state) shows the sender's own colours instead, in every reading layout and at
// every width, and above quoted history that was adapted too.

const DESIGNED = `<table width="100%" bgcolor="#ffffff"><tr><td style="background-color:#ffffff;color:#222222">Designed mail body</td></tr></table>`;
// bgcolor does not survive the reader's sanitizer, so this arrives with text colours only.
const COLOURS_ONLY = `<table width="100%" bgcolor="#f4f4f4"><tr><td><p id="text" style="color:#333333">Colours only mail body</p><p><a id="link" href="https://example.com/offer" style="color:#0000ee">the offer</a></p></td></tr></table>`;

const ids: Record<"designed" | "coloursOnly" | "plain", string> = { designed: "", coloursOnly: "", plain: "" };
const subjects = { designed: "", coloursOnly: "", plain: "" };

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	for (const [key, label, html] of [
		["designed", "Designed", DESIGNED],
		["coloursOnly", "Colours only", COLOURS_ONLY],
		["plain", "Plain", "<p>Plain mail body. Favourite color: blue; color: red.</p>"],
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

/**
 * What the reader actually sees: a screenshot of one element in the frame (computed styles do not include the
 * invert filter). The background is the most common pixel, the text colour the pixel furthest from it.
 */
async function paintedText(page: Page, selector: string) {
	const box = await page.getByTitle("Message body").evaluate((frame: HTMLIFrameElement, query: string) => {
		const frameBox = frame.getBoundingClientRect();
		const rect = frame.contentDocument!.querySelector(query)!.getBoundingClientRect();
		return {
			x: frameBox.x + rect.x,
			y: frameBox.y + rect.y,
			width: Math.ceil(rect.width),
			height: Math.ceil(rect.height),
		};
	}, selector);
	const png = (await page.screenshot({ clip: box })).toString("base64");
	return page.evaluate(async (base64: string) => {
		// The page's CSP does not allow fetch() of a data: URL, so decode the bytes into a Blob directly.
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
		const luminance = ([r, g, b]: number[]) => {
			const [lr, lg, lb] = [r, g, b].map((v) => {
				const c = v / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
		};
		const counts = new Map<string, number>();
		for (let i = 0; i < data.length; i += 4) {
			const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const background = [...counts.entries()]
			.sort((a, b) => b[1] - a[1])[0][0]
			.split(",")
			.map(Number);
		const backgroundLuminance = luminance(background);
		let text = background;
		let distance = 0;
		for (const key of counts.keys()) {
			const colour = key.split(",").map(Number);
			const gap = Math.abs(luminance(colour) - backgroundLuminance);
			if (gap > distance) [text, distance] = [colour, gap];
		}
		const [high, low] = [
			Math.max(luminance(text), backgroundLuminance),
			Math.min(luminance(text), backgroundLuminance),
		];
		return { text, contrast: (high + 0.05) / (low + 0.05) };
	}, png);
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
	// The label stays the same; only the pressed state tells on from off.
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await original();
	await toggle.focus();
	await page.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
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
				await expect(html(page)).toHaveCSS("filter", /invert/);
				// The sender's dark grey text and dark blue link are readable on the dark page: at least 4.5:1 as painted.
				// Polled: the app's loading splash can still cover the page right after navigation.
				await expect.poll(async () => (await paintedText(page, "p")).contrast).toBeGreaterThanOrEqual(4.5);
				await expect.poll(async () => (await paintedText(page, "a")).contrast).toBeGreaterThanOrEqual(4.5);
				const text = await paintedText(page, "p");
				const link = await paintedText(page, "a");
				// The link is still a blue, the text a neutral grey.
				expect(Math.max(...text.text) - Math.min(...text.text)).toBeLessThan(25);
				expect(link.text[2] - link.text[0]).toBeGreaterThan(40);
			},
			async () => {
				await expect(html(page)).toHaveCSS("filter", "none");
				await expect(html(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
				// The sender's colours on light: dark text on white.
				await expect.poll(async () => (await paintedText(page, "p")).text[0]).toBeLessThan(80);
			},
		);
	});
}

test("quoted history that dark mode adapts has its own button", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const reply = await deliverInbound(api, {
		from: `"Quote Sender" <quote@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Quoted ${token}`,
		html: `<p>My reply</p><div class="kite-quote" data-kite-quote="1">${COLOURS_ONLY}</div>`,
	});
	await api.dispose();
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", reply.id);
	const quoted = page.locator("details.email-quote-toggle");
	await quoted.locator("summary").click();
	const toggle = quoted.getByRole("button", { name: "Original colours" });
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(quoted.locator("iframe").contentFrame().locator("html")).toHaveCSS("filter", "none");
});

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
	await expect(page.getByRole("button", { name: /Original colours/ })).toHaveCount(0);
});

test("light mode has no button, even for mail with its own colours", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const id of [ids.designed, ids.coloursOnly]) {
		await open(page, "light", "right", id);
		await expect(page.getByRole("button", { name: /Original colours/ })).toHaveCount(0);
	}
});
