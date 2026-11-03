import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "./support/constants";
import { contrastBetween, luminancesBetween } from "./support/contrast";

// The home page at `/` is the product: a full-viewport mailbox whose folders are the navigation and whose emails
// are the content. The page never scrolls; the list and the reader scroll inside their panes.

const SOURCE_URL = "https://github.com/midego1/kite";
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_URL}`;
const HEADLINE = "Your own inbox for your own domains, running in your Cloudflare account.";

const reader = (page: Page) => page.getByRole("region", { name: "Reading pane" });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Folders" });
/** The open email: the one article that is not hidden. */
const openEmail = (page: Page) => page.locator('article[data-open="true"]');

/** Opens a folder from the sidebar and an email of it from the list (on a phone the list shows first). */
async function openFolderEmail(page: Page, folder: string, subject: string | RegExp) {
	await sidebar(page)
		.getByRole("button", { name: new RegExp(`^${folder}`) })
		.click();
	await page.getByRole("region", { name: folder }).getByRole("button", { name: subject }).click();
}

/** Opens the page and waits until the mailbox is interactive. */
async function visit(page: Page, path = "/") {
	await page.goto(path);
	await page.locator('[data-hydrated="true"]').waitFor();
}

async function pageScroll(page: Page) {
	return page.evaluate(() => ({
		vertical: document.documentElement.scrollHeight - window.innerHeight,
		horizontal: document.documentElement.scrollWidth - window.innerWidth,
		y: window.scrollY,
	}));
}

test.describe("visitor", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("is one full-viewport mailbox with the Welcome email open and the calls to action in view", async ({ page }) => {
		await visit(page);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);
		await expect(openEmail(page)).toHaveAttribute("id", "welcome");
		await expect(openEmail(page).getByText("is a self-hosted webmail app on Cloudflare Workers")).toBeVisible();
		await expect(openEmail(page).getByText("about 10 minutes the first time")).toBeVisible();
		await expect(page.getByRole("list", { name: "Facts" }).getByText("$0 to receive via Email Routing")).toBeVisible();
		await expect(
			page.getByRole("list", { name: "Facts" }).getByText("2,000+ unit · 400+ browser tests in CI"),
		).toBeVisible();
		await expect(openEmail(page).getByText(/\bstars?\b/i)).toHaveCount(0);

		const bar = page.getByRole("banner");
		await expect(bar.getByRole("link", { name: "Deploy to Cloudflare" })).toHaveAttribute("href", DEPLOY_URL);
		await expect(bar.getByRole("link", { name: "Deploy to Cloudflare" })).toHaveAttribute("target", "_blank");
		await expect(bar.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", SOURCE_URL);
		await expect(bar.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
		await expect(bar.getByRole("link", { name: "Open dashboard" })).toHaveCount(0);

		// Attribution stays in the sidebar: the licence and Mailflare.
		await expect(sidebar(page)).toContainText("free software under the AGPL-3.0");
		await expect(sidebar(page).getByRole("link", { name: "Mailflare" })).toHaveAttribute(
			"href",
			"https://github.com/hieunc229/mailflare",
		);
		await expect(sidebar(page).getByRole("link", { name: "Source code" })).toHaveAttribute("href", SOURCE_URL);
		await expect(sidebar(page).getByRole("link", { name: "AGPL-3.0 license" })).toBeVisible();

		// The page itself never scrolls, by wheel or by size.
		const before = await pageScroll(page);
		expect(before.vertical).toBeLessThanOrEqual(0);
		expect(before.horizontal).toBeLessThanOrEqual(0);
		await page.mouse.move(900, 500);
		await page.mouse.wheel(0, 2000);
		await page.waitForTimeout(200);
		expect((await pageScroll(page)).y).toBe(0);
		// The reader scrolls inside its own pane.
		expect(
			await reader(page)
				.locator(".home-scroll")
				.evaluate((element) => element.scrollTop),
		).toBeGreaterThan(0);
	});

	test("the server renders every email, with headings, so the content is in the HTML without JavaScript", async ({
		browser,
	}) => {
		const context = await browser.newContext({ javaScriptEnabled: false, storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await page.goto("/");
		// The Welcome email is readable as it stands.
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);
		await expect(page.locator("article#welcome")).toBeVisible();
		await expect(page.locator("article#welcome").getByText("Every feature is free.")).toBeVisible();
		// Every other email is in the document, each with its own subject heading.
		expect(await page.locator("article").count()).toBe(25);
		for (const id of [
			"deploy",
			"cost",
			"compare",
			"before-and-now",
			"limits",
			"faq-cost",
			"feature-ai",
			"open",
			"sample-invoice",
		]) {
			await expect(page.locator(`article#${id} :is(h1, h2)`).first()).toHaveCount(1);
		}
		expect(await page.locator("article#deploy").textContent()).toContain("docker compose up -d --build");
		expect(await page.locator("article#cost").textContent()).toContain("$0.10 per 1,000 emails");
		// Without JavaScript the folders could do nothing, so every email is shown, not only present, and they are gone.
		for (const [id, text] of [
			["feature-ai", "scoped keys that only see the tools they are allowed."],
			["deploy", "docker compose up -d --build"],
			["cost", "$0.10 per 1,000 emails"],
			["compare", "Young project, small community"],
			["before-and-now", "Completes"],
			["limits", "No published third-party security audit."],
			["faq-move", "Use IMAP import"],
			["open", "Discussions"],
			["sample-launch-plan", "launch-plan.pdf"],
			["sample-invoice", "fabrikam-invoice-2026-10.pdf"],
		]) {
			await expect(page.locator(`article#${id}`).getByText(text).first()).toBeVisible();
		}
		await expect(page.getByRole("complementary", { name: "Folders" })).toBeHidden();
		await expect(page.getByRole("button", { name: /^Cost/ })).toHaveCount(0);
		// With no script neither theme class is set and the app's look is the light one: the drawing's lines are dark.
		const ink = await page
			.locator(".home-page")
			.evaluate((element) => getComputedStyle(element).getPropertyValue("--home-draw-ink"));
		expect(ink).toContain("10 10 11");
		const root = page.locator(".home-page");
		expect((await luminancesBetween(root, root)).background).toBeGreaterThan(0.8);
		await context.close();
	});

	test("the folders and emails reach every piece of content", async ({ page }) => {
		await visit(page);
		const features = [
			["Six parts. All of them included.", "None of it needs a plan, a seat or a license key."],
			["A real inbox, not just forwarding", "Resizable panes, Gmail-style keys and a Cmd+K palette."],
			["Pick a provider per domain", "it asks before it replaces existing MX records."],
			["Calendar, booking pages and Drive", "Each module can be switched off."],
			["Safer by default", "Undo send gives you a moment to take a message back."],
			["AI that drafts, never sends", "scoped keys that only see the tools they are allowed."],
			["Open APIs", "There is no IMAP server for desktop apps."],
		];
		for (const [subject, text] of features) {
			await openFolderEmail(page, "Inbox", subject);
			await expect(openEmail(page).getByRole("heading", { name: subject, level: 2 })).toBeVisible();
			await expect(openEmail(page)).toContainText(text);
		}

		await openFolderEmail(page, "Deploy", "Deploy in five steps");
		const deploy = openEmail(page);
		await expect(deploy.locator("ol > li")).toHaveCount(5);
		await expect(deploy.getByRole("heading", { name: "Create a scoped CF_TOKEN" })).toBeVisible();
		await expect(deploy.getByRole("link", { name: "Read the deployment guide" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/blob/main/docs/deployment.md`,
		);
		await expect(deploy.getByText("docker compose up -d --build")).toBeVisible();
		await expect(deploy.getByRole("link", { name: "Self-hosting guide" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/blob/main/docs/self-hosting.md`,
		);
		await expect(deploy).toContainText("Never print, commit, or place these secrets");

		await openFolderEmail(page, "Cost", "Free to receive with Cloudflare, free tiers to send");
		const cost = openEmail(page);
		await expect(cost.getByRole("rowheader", { name: "Resend" })).toBeVisible();
		await expect(cost.getByRole("rowheader", { name: "Amazon SES" })).toBeVisible();
		await expect(cost.getByText("$0.10 per 1,000 emails")).toBeVisible();
		await expect(cost.getByText(/as of 2 Nov 2026/)).toBeVisible();
		await expect(cost.getByRole("link", { name: "Resend" }).last()).toHaveAttribute(
			"href",
			"https://resend.com/pricing",
		);

		await openFolderEmail(page, "Compare", "When Kite fits, and when it doesn't");
		const compare = openEmail(page);
		await expect(compare.getByRole("table", { name: /Comparison of Kite, Mailflare/ })).toBeAttached();
		await expect(compare.getByRole("rowheader", { name: "Maturity" })).toBeAttached();
		await expect(compare.getByRole("rowheader", { name: "Deliverability help" })).toBeAttached();
		await expect(compare.getByText("Young project, small community")).toBeVisible();
		await expect(compare.getByText(/spam filtering at scale/)).toBeVisible();
		await expect(compare.getByRole("columnheader", { name: "Hosted inboxes" })).toBeAttached();
		await page.getByRole("region", { name: "Compare" }).getByRole("button", { name: "Before and now" }).click();
		const before = openEmail(page);
		await expect(before.getByText("Measured on a production build in a plain Chrome profile.")).toBeVisible();
		await expect(before.getByRole("link", { name: "Performance in the README" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}#performance`,
		);
		await expect(before.getByText("~340 ms with an empty page and loading bar")).toBeVisible();
		await expect(before.getByText("~35–50 ms")).toBeVisible();
		await expect(before.getByText("Fails: Worker exceeds its 128 MB memory limit")).toBeVisible();
		await expect(before.getByText("Completes")).toBeVisible();

		await openFolderEmail(page, "Limits", "Early beta: what's missing today");
		await expect(openEmail(page).locator("ol > li")).toHaveCount(7);
		await expect(openEmail(page).getByText("No published third-party security audit.")).toBeVisible();
		await expect(openEmail(page).getByRole("link", { name: "See all known limitations" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}#known-limitations`,
		);

		const faq = [
			["How is Kite related to Mailflare?", /developed independently/],
			["What does it cost?", /Receiving through Email Routing is free/],
			["Do I need Cloudflare?", /A Docker build runs on any server/],
			["Can I use Apple Mail, Outlook or Thunderbird?", /Kite has no IMAP or SMTP server/],
			["Does Kite phone home?", /pseudonymous usage statistics/],
			["Will the AI send mail on its own?", /It drafts, and you confirm each send/],
			["How do I move my mail in?", /Use IMAP import/],
		] as const;
		for (const [question, answer] of faq) {
			await openFolderEmail(page, "FAQ", question);
			await expect(openEmail(page).getByRole("heading", { name: question, level: 2 })).toBeVisible();
			await expect(openEmail(page)).toContainText(answer);
		}
		await expect(openEmail(page).getByRole("link", { name: "Use IMAP import" })).toHaveCount(0);
		await openFolderEmail(page, "FAQ", "Does Kite phone home?");
		await expect(openEmail(page).getByRole("link", { name: "What is sent" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/blob/main/docs/privacy.md#usage-statistics`,
		);
		await expect(openEmail(page).getByText("KITE_TELEMETRY=0")).toBeVisible();

		await openFolderEmail(page, "Inbox", "Built in the open");
		for (const [label, path] of [
			["Changelog", "blob/main/CHANGELOG.md"],
			["Releases", "releases"],
			["Roadmap", "blob/main/ROADMAP.md"],
			["Discussions", "discussions"],
		]) {
			await expect(openEmail(page).getByRole("link", { name: label })).toHaveAttribute("href", `${SOURCE_URL}/${path}`);
		}

		// The folders count what is unread, and opening an email clears its dot.
		// Four example mails stay unread in the Inbox until they are opened.
		await expect(sidebar(page).getByRole("button", { name: /^Inbox/ })).toContainText("4");
	});

	test("search looks through every email", async ({ page }) => {
		await visit(page);
		await page.getByLabel("Search mail").fill("amazon ses");
		const results = page.getByRole("region", { name: "Search results" });
		expect(await results.getByRole("listitem").count()).toBeGreaterThan(2);
		await results.getByRole("button", { name: /Free to receive with Cloudflare, free tiers to send/ }).click();
		await expect(openEmail(page)).toHaveAttribute("id", "cost");
		await page.getByLabel("Search mail").fill("zzzz");
		await expect(page.getByText('No mail matches "zzzz".')).toBeVisible();
		await page.getByLabel("Search mail").fill("");
		// Opening a result moved the view to its folder, so clearing the search shows the opened email's folder.
		await expect(page.getByRole("region", { name: "Cost" })).toBeVisible();
		await expect(
			page.getByRole("region", { name: "Cost" }).getByRole("button", { name: /Free to receive/ }),
		).toHaveAttribute("aria-current", "true");
	});

	test("Copy prompt copies the verbatim deploy prompt", async ({ browser }) => {
		const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE_URL).origin });
		const page = await context.newPage();
		await visit(page, "/#deploy");
		const email = openEmail(page);
		await expect(email).toHaveAttribute("id", "deploy");
		const shown = (await email.locator("pre").last().innerText()).trim();
		expect(shown).toContain("Install Kite from https://github.com/midego1/kite in my Cloudflare account.");
		expect(shown).toContain("Never print, commit, or place these secrets in a command");
		await email.getByRole("button", { name: "Copy prompt" }).click();
		await expect(email.getByRole("button", { name: "Copied" })).toBeVisible();
		expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(shown);
		await context.close();
	});

	test("deep links open the right email, and Back moves between emails", async ({ page }) => {
		for (const [hash, id, folder] of [
			["deploy", "deploy", "Deploy"],
			["cost", "cost", "Cost"],
			["compare", "compare", "Compare"],
			["limits", "limits", "Limits"],
			["features", "features-intro", "Inbox"],
			["faq", "faq-mailflare", "FAQ"],
			["feature-ai", "feature-ai", "Inbox"],
		]) {
			await visit(page, `/#${hash}`);
			await expect(openEmail(page)).toHaveAttribute("id", id);
			await expect(sidebar(page).getByRole("button", { name: new RegExp(`^${folder}`) })).toHaveAttribute(
				"aria-current",
				"page",
			);
		}

		await visit(page);
		await expect(openEmail(page)).toHaveAttribute("id", "welcome");
		await openFolderEmail(page, "Cost", "Free to receive with Cloudflare, free tiers to send");
		await expect(page).toHaveURL(/#cost$/);
		await openFolderEmail(page, "Deploy", "Deploy in five steps");
		await expect(page).toHaveURL(/#deploy$/);
		await page.goBack();
		await expect(openEmail(page)).toHaveAttribute("id", "cost");
		await page.goBack();
		await expect(openEmail(page)).toHaveAttribute("id", "welcome");
		await page.goForward();
		await expect(openEmail(page)).toHaveAttribute("id", "cost");

		// A link inside an email opens its target the same way.
		await visit(page, "/#features-intro");
		await openEmail(page).getByRole("link", { name: "Open APIs" }).click();
		await expect(openEmail(page)).toHaveAttribute("id", "feature-api");
		await expect(page).toHaveURL(/#feature-api$/);
	});

	test("a person chip shows the address on hover and opens its contact card", async ({ page }) => {
		await visit(page);
		const chips = openEmail(page).getByRole("list", { name: "People in this conversation" });
		const chip = chips.getByRole("button", { name: "Kite", exact: true });
		await chip.hover();
		await expect(chips.getByRole("tooltip")).toHaveText("hello@kite.example");
		await chip.click();
		const card = page.getByRole("dialog", { name: "Contact card for Kite" });
		await expect(card).toBeVisible();
		await expect(card.getByText("hello@kite.example")).toBeVisible();
		await expect(card.getByRole("button", { name: "Copy address" })).toBeFocused();
		for (const action of ["New email", "Search Inbox for mail from Kite", "Edit contact", "Block contact"]) {
			await expect(card.getByRole("button", { name: action })).toBeVisible();
		}
		// The card sits inside the reader, never cut by it.
		const box = (await card.boundingBox())!;
		const pane = (await reader(page).boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(pane.x);
		expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
		expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);

		await card.getByRole("button", { name: "Edit contact" }).click();
		await expect(page.getByRole("status")).toContainText("Demo: nothing changes here");
		await chip.click();
		await card.getByRole("button", { name: "New email" }).click();
		const composer = page.getByRole("dialog", { name: "New message" });
		await expect(composer.getByLabel("To")).toHaveValue("hello@kite.example");
		await composer.getByRole("button", { name: "Send" }).click();
		await expect(page.getByRole("status")).toContainText("Demo: nothing sent");
		await chip.click();
		await card.getByRole("button", { name: "Search Inbox for mail from Kite" }).click();
		await expect(page.getByLabel("Search mail")).toHaveValue("Kite");
		await page.getByLabel("Search mail").fill("");

		// Escape closes the card and gives the focus back to the chip; "You" gets a card without actions.
		await chip.click();
		await page.keyboard.press("Escape");
		await expect(card).toHaveCount(0);
		await expect(chip).toBeFocused();
		await chips.getByRole("button", { name: "You" }).click();
		const own = page.getByRole("dialog", { name: "Contact card for You" });
		await expect(own.getByText("you@yourdomain.example")).toBeVisible();
		await expect(own.getByRole("button", { name: "Block contact" })).toHaveCount(0);
	});

	test("star, copy link and reply work and nothing leaves the page", async ({ browser }) => {
		const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE_URL).origin });
		const page = await context.newPage();
		await visit(page);
		const origin = new URL(page.url()).origin;
		const offending: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (!["http:", "https:"].includes(url.protocol)) return;
			const app = /^\/(api|jmap|mcp|\.well-known)(\/|$)/.test(url.pathname);
			if (url.origin !== origin || (app && request.method() !== "GET"))
				offending.push(`${request.method()} ${request.url()}`);
		});
		await page.getByRole("button", { name: "Star", exact: true }).click();
		await expect(page.getByRole("button", { name: "Unstar" })).toHaveAttribute("aria-pressed", "true");
		await sidebar(page).getByRole("button", { name: "Starred" }).click();
		await expect(page.getByRole("region", { name: "Starred" }).getByRole("listitem")).toHaveCount(1);
		await page.getByRole("button", { name: "Copy link" }).click();
		await expect(page.getByRole("status")).toContainText("Link copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#welcome$/);
		await page.getByRole("button", { name: "Reply" }).click();
		const composer = page.getByRole("dialog", { name: "New message" });
		await expect(composer.getByLabel("Subject")).toHaveValue(`Re: ${HEADLINE}`);
		await page.keyboard.press("Escape");
		await expect(composer).toHaveCount(0);
		await page.waitForLoadState("networkidle");
		expect(offending).toEqual([]);
		await context.close();
	});

	test("asks no third party for anything", async ({ page }) => {
		const origin = new URL(BASE_URL).origin;
		const foreign: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (!["http:", "https:"].includes(url.protocol)) return;
			if (url.origin !== origin) foreign.push(request.url());
		});
		await visit(page);
		for (const folder of ["Deploy", "Cost", "Compare", "Limits", "FAQ"]) {
			await sidebar(page)
				.getByRole("button", { name: new RegExp(`^${folder}`) })
				.click();
		}
		await page.waitForLoadState("networkidle");
		expect(foreign).toEqual([]);
	});

	test("works from the keyboard with visible focus, a skip link, a sound heading order and still motion", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await visit(page);
		await page.keyboard.press("Tab");
		await expect(page.getByRole("link", { name: "Skip to the message" })).toBeFocused();

		// Folders are buttons in the tab order; Enter opens one and the list follows.
		const cost = sidebar(page).getByRole("button", { name: /^Cost/ });
		await cost.focus();
		expect(await cost.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
		await page.keyboard.press("Enter");
		await expect(page.getByRole("region", { name: "Cost" })).toBeVisible();
		await expect(openEmail(page)).toHaveAttribute("id", "cost");

		// j and k work from a fresh load, before anything is focused, and keep working after a link was used.
		await visit(page);
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "features-intro");
		await openEmail(page).getByRole("link", { name: "Open APIs" }).focus();
		await page.keyboard.press("Enter");
		await expect(openEmail(page)).toHaveAttribute("id", "feature-api");
		await page.keyboard.press("k");
		await expect(openEmail(page)).toHaveAttribute("id", "feature-ai");
		await page.keyboard.press("k");
		await expect(openEmail(page)).toHaveAttribute("id", "feature-safety");
		// In a field they type.
		await page.getByLabel("Search mail").fill("j");
		await expect(openEmail(page)).toHaveAttribute("id", "feature-safety");
		await page.getByLabel("Search mail").fill("");

		// j and k move through a folder's list.
		await sidebar(page).getByRole("button", { name: /^FAQ/ }).click();
		await page.getByRole("region", { name: "FAQ" }).getByRole("button", { name: "What does it cost?" }).focus();
		await page.keyboard.press("Enter");
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "faq-cloudflare");
		await page.keyboard.press("k");
		await expect(openEmail(page)).toHaveAttribute("id", "faq-cost");

		// One h1; the subject is an h2 elsewhere and nothing skips a level inside the open email.
		await visit(page, "/#deploy");
		await expect(page.locator("h1")).toHaveCount(1);
		const levels = await openEmail(page)
			.locator("h1, h2, h3, h4")
			.evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])));
		expect(levels[0]).toBe(2);
		levels.forEach((level, index) => {
			if (index > 0) expect(level - levels[index - 1]).toBeLessThanOrEqual(1);
		});
		const animated = await page
			.locator(".home-trace, .home-fade, .home-flyline")
			.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
		expect(animated.every((name) => name === "none")).toBe(true);
	});

	test("is readable in dark and in light under every style, and the app's own pages are untouched", async ({
		page,
	}) => {
		for (const [theme, style] of [
			["dark", "kite"],
			["light", "kite"],
			["dark", "lavender"],
			["light", "lavender"],
		]) {
			const dark = theme === "dark";
			const visitPage = await page.context().newPage();
			await visitPage.addInitScript(
				([savedTheme, savedStyle]) => {
					localStorage.setItem("kite-theme", savedTheme);
					localStorage.setItem("kite-style", savedStyle);
				},
				[theme, style],
			);
			await visitPage.goto("/");
			await visitPage.locator('[data-hydrated="true"]').waitFor();
			await expect(visitPage.locator("html")).toHaveClass(dark ? /dark/ : /light/);
			const root = visitPage.locator(".home-page");
			const luminance = (await luminancesBetween(root, root)).background;
			if (dark) expect(luminance).toBeLessThan(0.15);
			else expect(luminance).toBeGreaterThan(0.8);
			const body = openEmail(visitPage);
			expect(await contrastBetween(body.getByRole("heading", { level: 1 }), root)).toBeGreaterThanOrEqual(4.5);
			expect(await contrastBetween(body.getByText("is a self-hosted webmail app"), root)).toBeGreaterThanOrEqual(4.5);
			expect(await contrastBetween(body.getByText("Needs a Cloudflare account"), root)).toBeGreaterThanOrEqual(4.5);
			expect(await contrastBetween(body.getByText("Open source · AGPL-3.0").first(), root)).toBeGreaterThanOrEqual(4.5);
			expect(
				await contrastBetween(visitPage.getByRole("region", { name: "Inbox" }).getByText("Built in the open"), root),
			).toBeGreaterThanOrEqual(4.5);
			expect(
				await contrastBetween(sidebar(visitPage).getByRole("button", { name: /^Cost/ }), sidebar(visitPage)),
			).toBeGreaterThanOrEqual(4.5);
			const deploy = visitPage.getByRole("banner").getByRole("link", { name: "Deploy to Cloudflare" });
			expect(await contrastBetween(deploy, deploy)).toBeGreaterThanOrEqual(4.5);
			await visitPage.close();
		}

		// The page's rules are scoped to its own wrapper: another page keeps the theme the visitor chose.
		await page.addInitScript(() => localStorage.setItem("kite-theme", "light"));
		await page.goto("/login");
		await expect(page.locator(".home-page")).toHaveCount(0);
		expect((await luminancesBetween(page.locator("body"), page.locator("body"))).background).toBeGreaterThan(0.5);
	});

	test("the header toggle switches the app's theme, keeps it after a reload and honours the system setting", async ({
		browser,
	}) => {
		const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, colorScheme: "light" });
		const page = await context.newPage();
		await visit(page);
		// Kite is dark-first: with nothing saved the page is dark, whatever the system says.
		await expect(page.locator("html")).toHaveClass(/dark/);
		const root = page.locator(".home-page");
		expect((await luminancesBetween(root, root)).background).toBeLessThan(0.15);

		await page.getByRole("banner").getByRole("button", { name: "Switch to light mode" }).click();
		await expect(page.locator("html")).toHaveClass(/light/);
		expect(await page.evaluate(() => localStorage.getItem("kite-theme"))).toBe("light");
		expect((await luminancesBetween(root, root)).background).toBeGreaterThan(0.8);

		await page.reload();
		await page.locator('[data-hydrated="true"]').waitFor();
		await expect(page.locator("html")).toHaveClass(/light/);
		await expect(page.getByRole("banner").getByRole("button", { name: "Switch to dark mode" })).toBeVisible();

		await page.getByRole("banner").getByRole("button", { name: "Switch to dark mode" }).click();
		await expect(page.locator("html")).toHaveClass(/dark/);
		// Dark is the default, so choosing it clears the saved value, as in Settings.
		expect(await page.evaluate(() => localStorage.getItem("kite-theme"))).toBeNull();

		// "Match system" in Settings is honoured.
		await page.evaluate(() => localStorage.setItem("kite-theme", "system"));
		await page.reload();
		await page.locator('[data-hydrated="true"]').waitFor();
		await expect(page.locator("html")).toHaveClass(/light/);
		await context.close();
	});

	test("a load never moves the focus", async ({ page }) => {
		for (const width of [884, 390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await visit(page);
			await page.waitForTimeout(300);
			expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
		}
	});

	test("the comparison is a table with its columns side by side in a wide reader and stacked blocks in a narrow one", async ({
		page,
	}) => {
		const state = () =>
			openEmail(page).evaluate((article) => {
				const table = article.querySelector("table")!;
				const heads = [...table.querySelectorAll('th[scope="col"]')].map((cell) => cell.getBoundingClientRect());
				const pane = article.closest(".home-scroll")!;
				return {
					display: getComputedStyle(table).display,
					headLefts: heads.map((rect) => Math.round(rect.left)),
					headVisible: heads.every((rect) => rect.width > 4),
					overflow: pane.scrollWidth - pane.clientWidth,
					paneWidth: pane.clientWidth,
				};
			});

		// The pane's width decides, not the window's: the sidebar and the list take room, so 1366 px is still stacked.
		for (const [width, wide] of [
			[1920, true],
			[1440, true],
			[1280, false],
			[884, false],
			[390, false],
		] as const) {
			await page.setViewportSize({ width, height: 900 });
			await visit(page, "/#compare");
			const compare = await state();
			expect(compare.display, `compare at ${width}`).toBe(wide ? "table" : "block");
			expect(compare.overflow).toBeLessThanOrEqual(0);
			if (wide) {
				// Four columns beside each other, each with its own left edge, named by its header.
				expect(new Set(compare.headLefts).size).toBe(4);
				expect(compare.headVisible).toBe(true);
				await expect(openEmail(page).getByRole("columnheader", { name: "Mailflare" })).toBeVisible();
				await expect(openEmail(page).getByRole("columnheader", { name: "Email Routing alone" })).toBeVisible();
				await expect(openEmail(page).getByRole("columnheader", { name: "Hosted inboxes" })).toBeVisible();
			} else {
				// Stacked: every cell names its column.
				await expect(openEmail(page).locator('td[data-label="Mailflare"]').first()).toBeVisible();
				await expect(openEmail(page).getByRole("columnheader", { name: "Mailflare" })).toBeAttached();
			}
			const scroll = await pageScroll(page);
			expect(scroll.vertical).toBeLessThanOrEqual(0);
			expect(scroll.horizontal).toBeLessThanOrEqual(0);

			// The price table fits the same pane and is a table once it has 36rem.
			await visit(page, "/#cost");
			const cost = await state();
			expect(cost.display, `cost at ${width}`).toBe(cost.paneWidth >= 576 + 48 ? "table" : "block");
			expect(cost.overflow).toBeLessThanOrEqual(0);
		}
	});

	test("a wide comparison keeps its header in view while the reader scrolls", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 700 });
		await visit(page, "/#compare");
		const header = openEmail(page).getByRole("columnheader", { name: "Kite" }).first();
		const pane = reader(page).locator(".home-scroll");
		await pane.evaluate((element) => element.scrollTo({ top: 400 }));
		await page.waitForTimeout(150);
		const paneTop = (await pane.boundingBox())!.y;
		const headTop = (await header.boundingBox())!.y;
		expect(Math.abs(headTop - paneTop)).toBeLessThan(40);
		expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
	});

	test("example mails show the inbox in use, are marked as examples and act only on the page", async ({ page }) => {
		await visit(page);
		const inbox = page.getByRole("region", { name: "Inbox" });
		// Below the feature emails and before Built in the open, each marked on its row.
		const subjects = await inbox.getByRole("listitem").evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
		const at = (text: string) => subjects.findIndex((row) => row.includes(text));
		expect(at("Open APIs")).toBeLessThan(at("Re: Launch plan for the new inbox"));
		expect(at("Your October invoice is ready")).toBeLessThan(at("Built in the open"));
		expect(await inbox.getByText("Example", { exact: true }).count()).toBe(4);
		await expect(inbox.getByText("New sender")).toHaveCount(1);
		await expect(sidebar(page).getByRole("button", { name: /^Inbox/ })).toContainText("12");

		// Reply drafted: the card, its wording, the draft in the composer, and nothing sent.
		await inbox.getByRole("button", { name: /Re: Launch plan for the new inbox/ }).click();
		const mail = openEmail(page);
		await expect(mail).toHaveAttribute("id", "sample-launch-plan");
		await expect(mail.getByText("An example mail: the people and addresses are invented")).toBeVisible();
		await expect(mail.getByText("Reply drafted")).toBeVisible();
		await expect(mail.getByText("Suggestion, nothing sent")).toBeVisible();
		await expect(mail.getByText("launch-plan.pdf")).toBeVisible();
		await expect(mail.getByText("rollout-checklist.csv")).toBeVisible();
		await mail.getByRole("button", { name: "Review draft" }).click();
		const composer = page.getByRole("dialog", { name: "New message" });
		await expect(composer.getByLabel("To")).toHaveValue("sofia@northwind.test");
		await expect(composer.getByLabel("Subject")).toHaveValue("Re: Launch plan for the new inbox");
		await expect(composer.getByLabel("Message")).toHaveValue(/Thanks Sofia, both files are in\./);
		await composer.getByRole("button", { name: "Send" }).click();
		await expect(page.getByRole("status")).toContainText("Demo: nothing sent");
		// The Reply button keeps the one Re: prefix the subject already has.
		await reader(page).getByRole("button", { name: "Reply", exact: true }).click();
		await expect(composer.getByLabel("Subject")).toHaveValue("Re: Launch plan for the new inbox");
		await composer.getByRole("button", { name: "Close" }).click();
		await mail.getByRole("button", { name: "Dismiss" }).click();
		await expect(mail.getByText("Reply drafted")).toHaveCount(0);

		// The contact card of an example sender shows an invented address.
		await mail.getByRole("button", { name: "Sofia Marchetti", exact: true }).click();
		await expect(
			page.getByRole("dialog", { name: "Contact card for Sofia Marchetti" }).getByText("sofia@northwind.test"),
		).toBeVisible();
		await page.keyboard.press("Escape");

		// New sender: the label on the row, the Screener bar in the email, and a local decision.
		await inbox.getByRole("button", { name: /A question about a shared mailing/ }).click();
		await expect(openEmail(page)).toHaveAttribute("id", "sample-api-question");
		await openEmail(page).getByRole("button", { name: "Approve" }).click();
		await expect(page.getByRole("status")).toContainText(
			"Approved. Mail from Ava Lindqvist now arrives in your Inbox.",
		);
		await expect(inbox.getByText("New sender")).toHaveCount(0);
		await expect(openEmail(page).getByRole("button", { name: "Deny" })).toHaveCount(0);

		// Attachments, a deep link and search.
		await visit(page, "/#sample-invoice");
		await expect(openEmail(page).getByText("fabrikam-invoice-2026-10.pdf")).toBeVisible();
		await page.getByLabel("Search mail").fill("fabrikam");
		await expect(page.getByRole("region", { name: "Search results" }).getByRole("listitem")).toHaveCount(1);
		// The suggestion's draft text is indexed too.
		await page.getByLabel("Search mail").fill("DNS step");
		await expect(page.getByRole("region", { name: "Search results" }).getByRole("listitem")).toHaveCount(1);
		await page.getByLabel("Search mail").fill("example");
		expect(await page.getByRole("region", { name: "Search results" }).getByRole("listitem").count()).toBe(4);
		await page.getByLabel("Search mail").fill("");

		// j and k step through the examples in list order.
		await visit(page, "/#feature-api");
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "sample-launch-plan");
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "sample-design-review");
		await page.keyboard.press("j");
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "sample-invoice");
		await page.keyboard.press("j");
		await expect(openEmail(page)).toHaveAttribute("id", "open");
	});

	test("the folder menu below lg takes the focus, holds it and gives it back", async ({ page }) => {
		await page.setViewportSize({ width: 884, height: 1104 });
		await visit(page);
		const openMenu = page.getByRole("button", { name: "Open menu" });
		await openMenu.click();
		await expect(sidebar(page).getByRole("button", { name: "Close menu" })).toBeFocused();
		// Tab goes round inside the menu and never reaches what is behind the backdrop.
		const stops = sidebar(page).locator("button, a[href]");
		const count = await stops.count();
		for (let step = 0; step < count + 2; step++) {
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Folders"]'))).toBe(true);
		}
		await page.keyboard.press("Shift+Tab");
		expect(await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Folders"]'))).toBe(true);
		await page.keyboard.press("Escape");
		await expect(sidebar(page)).toBeHidden();
		await expect(openMenu).toBeFocused();
		await openMenu.click();
		await sidebar(page).getByRole("button", { name: /^Cost/ }).click();
		await expect(openEmail(page)).toHaveAttribute("id", "cost");
		await expect(openMenu).toBeFocused();

		// New email from the menu closes it, so the composer's own fields are what Tab reaches, and closing it lands on Open menu.
		await openMenu.click();
		await sidebar(page).getByRole("button", { name: "New email" }).click();
		await expect(sidebar(page)).toBeHidden();
		const composer = page.getByRole("dialog", { name: "New message" });
		await expect(composer.getByLabel("To")).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(composer.getByLabel("Subject")).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(composer.getByLabel("Message")).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(composer.getByRole("button", { name: "Send" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(composer).toHaveCount(0);
		await expect(openMenu).toBeFocused();
	});

	test("on a phone the skip link opens the message, and a folder's first email is read once it is shown", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await visit(page, "/#cost");
		await page.getByRole("button", { name: "Back to list" }).click();
		await expect(reader(page)).toBeHidden();
		await page.keyboard.press("Tab");
		await page.getByRole("link", { name: "Skip to the message" }).press("Enter");
		await expect(reader(page)).toBeVisible();
		await expect(openEmail(page)).toBeFocused();

		// A folder tapped on a phone leaves its first email unread until the reader shows it, e.g. after widening.
		await page.getByRole("button", { name: "Back to list" }).click();
		await page.getByRole("button", { name: "Open menu" }).click();
		await sidebar(page)
			.getByRole("button", { name: /^Limits/ })
			.click();
		await expect(reader(page)).toBeHidden();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(reader(page)).toBeVisible();
		await expect(sidebar(page).getByRole("button", { name: /^Limits/ })).not.toContainText("1");
	});

	test("the brand goes home from an open email, and the composer from the contact card returns to its chip", async ({
		page,
	}) => {
		await visit(page, "/#deploy");
		await expect(openEmail(page)).toHaveAttribute("id", "deploy");
		await page.getByRole("banner").getByRole("link", { name: "Kite home" }).click();
		await expect(openEmail(page)).toHaveAttribute("id", "welcome");
		await expect(page).toHaveURL(/\/$/);
		await page.goBack();
		await expect(openEmail(page)).toHaveAttribute("id", "deploy");

		const chip = openEmail(page).getByRole("button", { name: "Kite", exact: true });
		await chip.click();
		await page
			.getByRole("dialog", { name: "Contact card for Kite" })
			.getByRole("button", { name: "New email" })
			.click();
		await expect(page.getByRole("dialog", { name: "New message" }).getByLabel("To")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(chip).toBeFocused();
	});

	test("on a phone it shows one pane at a time, with Back and the folders in a menu", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await visit(page);
		// The Welcome email is what opens; the calls to action stay in view.
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(page.getByRole("banner").getByRole("link", { name: "Deploy to Cloudflare" })).toBeVisible();
		await expect(page.getByRole("banner").getByRole("link", { name: "View on GitHub" })).toBeVisible();
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
		await expect(sidebar(page)).toBeHidden();

		await page.getByRole("button", { name: "Back to list" }).click();
		await expect(page.getByRole("region", { name: "Inbox" })).toBeVisible();
		await expect(reader(page)).toBeHidden();
		await page.getByRole("button", { name: "Open menu" }).click();
		await expect(sidebar(page)).toBeVisible();
		await sidebar(page).getByRole("button", { name: /^Cost/ }).click();
		await expect(sidebar(page)).toBeHidden();
		await page
			.getByRole("region", { name: "Cost" })
			.getByRole("button", { name: /Free to receive/ })
			.click();
		await expect(reader(page)).toBeVisible();
		await expect(openEmail(page).getByText("$0.10 per 1,000 emails")).toBeVisible();
		await page.getByRole("button", { name: "Back to list" }).click();
		await expect(page.getByRole("region", { name: "Cost" })).toBeVisible();

		// Everything is reachable: the Deploy email, its prompt button and the comparison, stacked row by row.
		await visit(page, "/#compare");
		await expect(openEmail(page).getByText("Young project, small community")).toBeVisible();
		await visit(page, "/#deploy");
		await expect(openEmail(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
		const scroll = await pageScroll(page);
		expect(scroll.vertical).toBeLessThanOrEqual(0);
		expect(scroll.horizontal).toBeLessThanOrEqual(0);
	});

	test("on a foldable width it shows the list and the reader, and every email fits", async ({ page }) => {
		await page.setViewportSize({ width: 884, height: 1104 });
		await visit(page);
		await expect(page.getByRole("region", { name: "Inbox" })).toBeVisible();
		await expect(reader(page)).toBeVisible();
		await expect(sidebar(page)).toBeHidden();
		await page.getByRole("button", { name: "Open menu" }).click();
		await sidebar(page)
			.getByRole("button", { name: /^Compare/ })
			.click();
		await expect(openEmail(page)).toHaveAttribute("id", "compare");
		await expect(openEmail(page).getByText("Young project, small community")).toBeVisible();
		await visit(page, "/#cost");
		await expect(openEmail(page).getByRole("rowheader", { name: "Resend" })).toBeVisible();
		const scroll = await pageScroll(page);
		expect(scroll.vertical).toBeLessThanOrEqual(0);
		expect(scroll.horizontal).toBeLessThanOrEqual(0);
		// No table pushes the reader sideways.
		expect(
			await reader(page)
				.locator(".home-scroll")
				.evaluate((element) => element.scrollWidth - element.clientWidth),
		).toBeLessThanOrEqual(0);
	});
});

test.describe("signed in", () => {
	test("keeps the page and offers the dashboard", async ({ page }) => {
		await visit(page);
		const open = page.getByRole("banner").getByRole("link", { name: "Open dashboard" });
		await expect(open).toHaveAttribute("href", "/inbox");
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADLINE);
		await open.click();
		await expect(page).toHaveURL(/\/inbox$/);
	});
});
