import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Dark mode adapts mail that brings its own colours, depending on the colours:
//  - a background, or a text colour that stays unreadable on dark (grey #555, a #1F497D signature): rendered light
//    and inverted;
//  - near-black text only (Outlook's color:black, Gmail's #222): the declarations are dropped, so the text takes
//    the theme colour and a reply looks like plain mail;
//  - colours that read fine on dark (light text): left alone.
// The small "Original colours" button above the body (a fixed label with a pressed state) shows the sender's own
// colours whenever something was changed, in every reading layout and at every width. Quoted history follows it.

const DESIGNED = `<table width="100%" bgcolor="#ffffff"><tr><td style="background-color:#ffffff;color:#222222">Designed mail body</td></tr></table>`;
// bgcolor does not survive the reader's sanitizer, so this arrives with text colours only; grey #555 is not near-black
// and stays unreadable on dark, so it is inverted.
const COLOURS_ONLY = `<table width="100%" bgcolor="#f4f4f4"><tr><td><p style="color:#555555">Colours only mail body</p><p><a href="https://example.com/offer" style="color:#0000ee">the offer</a></p></td></tr></table>`;
// Outlook writes color:black / windowtext on almost every block.
const OUTLOOK = `<p style="margin:0cm;color:black">Outlook reply body</p><p style="margin:0cm;color:windowtext">Second Outlook line</p>`;
const LIGHT = `<p style="color:#e8eaed">Light text mail body</p>`;

// Only the parsed styles count: text that mentions a style, a colour or a background is just text.
const TEXTUAL = `<p>Plain text mentioning style="color: rgb(31,73,125)" and background-color: red.</p><pre>&lt;td style="color:#000"&gt;</pre>`;
const DIMGRAY = `<p style="color:dimgray">Dimgray mail body</p>`;

type Kind = "designed" | "coloursOnly" | "outlook" | "light" | "plain" | "textual" | "dimgray";
const ids = {} as Record<Kind, string>;
const subjects = {} as Record<Kind, string>;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	for (const [key, label, html] of [
		["designed", "Designed", DESIGNED],
		["coloursOnly", "Colours only", COLOURS_ONLY],
		["outlook", "Outlook", OUTLOOK],
		["light", "Light", LIGHT],
		["textual", "Textual", TEXTUAL],
		["dimgray", "Dimgray", DIMGRAY],
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
		// The most blue pixel (blue minus red), for telling a link from grey text.
		let blueness = -255;
		for (let i = 0; i < data.length; i += 4) blueness = Math.max(blueness, data[i + 2] - data[i]);
		return { text, contrast: (high + 0.05) / (low + 0.05), blueness };
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

	test(`dark mode, mail with an unreadable text colour: Original colours toggles the frame (${label})`, async ({
		page,
	}) => {
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
				// The link is still a blue, the text a neutral grey.
				await expect.poll(async () => (await paintedText(page, "a")).blueness).toBeGreaterThan(40);
				await expect.poll(async () => (await paintedText(page, "p")).blueness).toBeLessThan(25);
			},
			async () => {
				await expect(html(page)).toHaveCSS("filter", "none");
				await expect(html(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
				// The sender's colours on light: dark text on white.
				await expect.poll(async () => (await paintedText(page, "p")).text[0]).toBeLessThan(120);
			},
		);
	});
}

test("Outlook-style black text: no inverted card, theme colours, and the button restores the original", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", ids.outlook);
	const toggle = page.getByRole("button", { name: "Original colours" });
	await expect(toggle).toBeVisible();
	// Like plain mail: transparent canvas, no padding, no filter, and the text colour is the theme's.
	await expect(html(page)).toHaveCSS("filter", "none");
	await expect(html(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(html(page)).toHaveCSS("color-scheme", "dark");
	await expect(page.getByTitle("Message body").contentFrame().locator("body")).toHaveCSS("padding", "0px");
	await expect.poll(async () => (await paintedText(page, "p")).contrast).toBeGreaterThanOrEqual(4.5);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(html(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
	await expect.poll(async () => (await paintedText(page, "p")).text[0]).toBeLessThan(40);
});

test("text that only mentions a style is not adapted and is shown as written", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", ids.textual);
	const frame = page.getByTitle("Message body").contentFrame();
	await expect(frame.locator("pre")).toHaveText('<td style="color:#000">');
	await expect(frame.locator("p")).toContainText('style="color: rgb(31,73,125)" and background-color: red.');
	await expect(html(page)).toHaveCSS("filter", "none");
	await expect(html(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(page.getByRole("button", { name: "Original colours" })).toHaveCount(0);
});

test("a named colour that is unreadable on dark (dimgray) is adapted too", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", ids.dimgray);
	await expect(page.getByRole("button", { name: "Original colours" })).toBeVisible();
	await expect(html(page)).toHaveCSS("filter", /invert/);
	await expect.poll(async () => (await paintedText(page, "p")).contrast).toBeGreaterThanOrEqual(4.5);
});

test("light text on dark is left alone: no button, readable, untouched", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", ids.light);
	await expect(html(page)).toHaveCSS("filter", "none");
	await expect(html(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect.poll(async () => (await paintedText(page, "p")).contrast).toBeGreaterThanOrEqual(4.5);
	await expect(page.getByRole("button", { name: "Original colours" })).toHaveCount(0);
});

test("quoted history follows the message's one button", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const reply = await deliverInbound(api, {
		from: `"Quote Sender" <quote@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Quoted ${token}`,
		html: `<p>My plain reply</p><div class="kite-quote" data-kite-quote="1">${COLOURS_ONLY}</div>`,
	});
	await api.dispose();
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, "dark", "right", reply.id);
	const quoted = page.locator("details.email-quote-toggle");
	await quoted.locator("summary").click();
	const quotedHtml = quoted.locator("iframe").contentFrame().locator("html");
	// The reply itself is plain, only the history was adapted: still one button, above the message body.
	const toggle = page.getByRole("button", { name: "Original colours" });
	await expect(toggle).toHaveCount(1);
	await expect(quoted.getByRole("button")).toHaveCount(0);
	await expect(quotedHtml).toHaveCSS("filter", /invert/);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(quotedHtml).toHaveCSS("filter", "none");
	await toggle.click();
	await expect(quotedHtml).toHaveCSS("filter", /invert/);
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
	for (const id of [ids.designed, ids.coloursOnly, ids.outlook]) {
		await open(page, "light", "right", id);
		await expect(page.getByRole("button", { name: /Original colours/ })).toHaveCount(0);
	}
});
