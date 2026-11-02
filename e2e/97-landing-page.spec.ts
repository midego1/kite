import { expect, test, type Page } from "@playwright/test";
import { contrastBetween, luminancesBetween } from "./support/contrast";

// The landing page at `/`: what a visitor sees (the hero, the proof, deploy, cost and comparison),
// what a signed-in user sees instead (the dashboard button), and that it holds up in dark mode and on a phone.

const SOURCE_URL = "https://github.com/midego1/kite";
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_URL}`;

function hero(page: Page) {
	return page.getByRole("region", { name: /running in your Cloudflare account/ });
}

async function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const main = document.querySelector("main");
		const whole = document.documentElement.scrollWidth - window.innerWidth;
		return Math.max(whole, main ? main.scrollWidth - main.clientWidth : 0);
	});
}

test.describe("visitor", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("shows the hero, the ways in, the product preview and every section", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"Your own inbox for your own domains, running in your Cloudflare account.",
		);

		const heroSection = hero(page);
		const deploy = heroSection.getByRole("link", { name: "Deploy to Cloudflare" });
		await expect(deploy).toHaveAttribute("href", DEPLOY_URL);
		await expect(deploy).toHaveAttribute("target", "_blank");
		await expect(heroSection.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", SOURCE_URL);
		await expect(heroSection.getByRole("link", { name: "Sign in" })).toHaveCount(0);
		await expect(heroSection.getByRole("link", { name: "Open dashboard" })).toHaveCount(0);
		await expect(heroSection.getByText("about 10 minutes the first time")).toBeVisible();
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

		// The preview is a live demo on invented data; it renders on the server first and becomes interactive once its
		// chunk has loaded, with the same markup.
		const preview = page.getByTestId("home-product-mock");
		await expect(preview).toBeVisible();
		await expect(preview).toHaveAttribute("role", "region");
		await expect(preview).toHaveAttribute("aria-label", /invented data/);
		await expect(preview.getByText("Kite was updated")).toBeVisible();
		await expect(preview.getByText("New sender").first()).toBeVisible();
		await expect(preview.getByText("launch-plan.pdf")).toBeVisible();
		await expect(preview.getByText("Reply drafted")).toBeVisible();
		await expect(page.getByText("Try it — it's a live demo")).toBeVisible();

		await expect(page.getByRole("heading", { level: 2, name: "Six parts. All of them included." })).toBeVisible();
		for (const title of [
			"A real inbox, not just forwarding",
			"Pick a provider per domain",
			"Calendar, booking pages and Drive",
			"Safer by default",
			"AI that drafts, never sends",
			"Open APIs",
		]) {
			await expect(page.getByRole("heading", { level: 3, name: title })).toBeVisible();
		}
		await expect(page.getByRole("contentinfo")).toContainText("free software under the AGPL-3.0");
		await expect(page.getByRole("contentinfo").getByRole("link", { name: "Mailflare" })).toHaveAttribute(
			"href",
			"https://github.com/hieunc229/mailflare",
		);
		await expect(page.getByRole("contentinfo").getByRole("link", { name: "Source code" })).toHaveAttribute(
			"href",
			SOURCE_URL,
		);
		expect(await horizontalOverflow(page)).toBe(0);
	});

	test("shows the proof, the cost, the comparison, the limits and the questions", async ({ page }) => {
		await page.goto("/");
		const proof = page.getByRole("region", { name: "Proof" });
		await expect(proof.getByText("AGPL-3.0")).toBeVisible();
		await expect(proof.getByText("$0 to receive via Email Routing")).toBeVisible();
		await expect(proof.getByText("2,000+ unit · 400+ browser tests in CI")).toBeVisible();
		await expect(proof.getByText(/star/i)).toHaveCount(0);

		const deploy = page.getByRole("region", { name: "Deploy in five steps" });
		await expect(deploy.getByRole("listitem")).toHaveCount(5);
		await expect(deploy.getByRole("link", { name: "Read the deployment guide" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/blob/main/docs/deployment.md`,
		);
		await expect(deploy.getByText("docker compose up -d --build")).toBeVisible();
		await deploy.getByText("Show the deploy prompt").click();
		await expect(deploy.getByText("Never print, commit, or place these secrets")).toBeVisible();

		const cost = page.getByRole("region", { name: "Free to receive, free tiers to send" });
		await expect(cost.getByRole("rowheader", { name: "Resend" })).toBeVisible();
		await expect(cost.getByText("$0.10 per 1,000 emails")).toBeVisible();
		await expect(cost.getByText("as of 2 Nov 2026")).toBeVisible();
		await expect(cost.getByText(/\$1,800/)).toHaveCount(0);

		const compare = page.getByRole("region", { name: "When Kite fits, and when it doesn't" });
		await expect(compare.getByRole("columnheader", { name: "Mailflare" })).toBeVisible();
		await expect(compare.getByRole("columnheader", { name: "Hosted inboxes" })).toBeVisible();
		await expect(compare.getByRole("rowheader", { name: "Maturity" })).toBeVisible();
		await expect(compare.getByRole("rowheader", { name: "Deliverability help" })).toBeVisible();
		await expect(compare.getByText("Young project, small community")).toBeVisible();
		await expect(compare.getByText(/spam filtering at scale/)).toBeVisible();
		await expect(compare.getByRole("heading", { name: "Before and now" })).toBeVisible();
		await expect(compare.getByText("Measured on a production build in a plain Chrome profile.")).toBeVisible();
		await expect(compare.getByRole("link", { name: "Performance in the README" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}#performance`,
		);
		await expect(compare.getByRole("columnheader", { name: "Before" })).toBeVisible();
		await expect(compare.getByRole("columnheader", { name: "Now" })).toBeVisible();
		await expect(compare.getByRole("rowheader", { name: "Opening a folder for the first time" })).toBeVisible();
		await expect(compare.getByText("~340 ms with an empty page and loading bar")).toBeVisible();
		await expect(compare.getByText("~35–50 ms")).toBeVisible();
		await expect(compare.getByRole("rowheader", { name: "Backing up a 53 MB database" })).toBeVisible();
		await expect(compare.getByText("Fails: Worker exceeds its 128 MB memory limit")).toBeVisible();
		await expect(compare.getByText("Completes")).toBeVisible();

		const limits = page.getByRole("region", { name: "Early beta: what's missing today" });
		await expect(limits.getByText("No published third-party security audit.")).toBeVisible();
		await expect(limits.getByRole("link", { name: "See all known limitations" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}#known-limitations`,
		);

		const faq = page.getByRole("region", { name: "FAQ" });
		await faq.getByText("How is Kite related to Mailflare?").click();
		await expect(faq.getByText(/developed independently/)).toBeVisible();
		await expect(faq.getByRole("link", { name: "Mailflare" })).toHaveAttribute(
			"href",
			"https://github.com/hieunc229/mailflare",
		);

		const closing = page.getByRole("region", { name: "Run your own inbox." });
		await expect(closing.getByRole("link", { name: "Deploy to Cloudflare" })).toHaveAttribute("href", DEPLOY_URL);
		await expect(closing.getByRole("link", { name: "Read the docs" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/tree/main/docs`,
		);

		const text = await page.locator("main").innerText();
		expect(text).not.toMatch(/kitemail|Wall of Love|Boat CI|\$1,800/i);
		expect(await horizontalOverflow(page)).toBe(0);
	});

	test("Sign in from the header opens the sign-in page", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByLabel("Email")).toBeVisible();
	});

	test("follows the dark theme with readable text", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-theme", "dark"));
		await page.goto("/");
		await expect(page.locator("html")).toHaveClass(/dark/);
		const heading = page.getByRole("heading", { level: 1 });
		const body = page.locator("body");
		expect((await luminancesBetween(heading, body)).background).toBeLessThan(0.1);
		expect(await contrastBetween(heading, body)).toBeGreaterThanOrEqual(4.5);
		// The preview is a dark card too, not a white block on a dark page.
		const preview = page.getByTestId("home-product-mock");
		expect((await luminancesBetween(preview, preview)).background).toBeLessThan(0.15);
		expect(
			await contrastBetween(preview.getByText("Design review notes for the new onboarding"), preview),
		).toBeGreaterThanOrEqual(4.5);

		// Kite classic (the lavender style) in dark keeps the demo readable and sets the accent line in its script face.
		await page.addInitScript(() => localStorage.setItem("kite-style", "lavender"));
		await page.goto("/");
		await expect(page.locator("html")).toHaveAttribute("data-style", "lavender");
		const accent = page.locator("h1 .home-accent");
		expect(await accent.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/Madi|cursive/);
		const demoAgain = await liveDemo(page);
		await demoAgain.getByRole("button", { name: /Lena Fischer/ }).click();
		expect(
			await contrastBetween(demoAgain.getByText("I lean towards letting them skip it."), demoAgain),
		).toBeGreaterThanOrEqual(4.5);
		await demoAgain.getByRole("button", { name: "Archive" }).click();
		const toast = demoAgain.getByRole("status");
		expect(await contrastBetween(toast, toast)).toBeGreaterThanOrEqual(4.5);
	});

	test("fits a phone without horizontal overflow", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		const heroSection = hero(page);
		await expect(heroSection.getByRole("link", { name: "Deploy to Cloudflare" })).toBeVisible();
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
		// The header keeps only Sign in on a phone; the deploy button lives in the hero.
		await expect(page.getByRole("banner").getByRole("link", { name: "Deploy to Cloudflare" })).toBeHidden();
		// The preview shows the message list alone, like the app on a phone.
		const preview = page.getByTestId("home-product-mock");
		await expect(preview.getByText("Design review notes for the new onboarding")).toBeVisible();
		await expect(preview.getByRole("button", { name: "Summarize" })).toBeHidden();
		expect(await horizontalOverflow(page)).toBe(0);
		await page.getByRole("heading", { level: 2, name: "Deploy in five steps" }).scrollIntoViewIfNeeded();
		expect(await horizontalOverflow(page)).toBe(0);
		await page.getByRole("heading", { level: 2, name: "When Kite fits, and when it doesn't" }).scrollIntoViewIfNeeded();
		await page.getByRole("heading", { level: 3, name: "Before and now" }).scrollIntoViewIfNeeded();
		expect(await horizontalOverflow(page)).toBe(0);
	});
});

/** The live demo once its chunk has loaded (home-demo-host.tsx swaps it in during idle time or at the first hover). */
async function liveDemo(page: Page) {
	const demo = page.getByTestId("home-product-mock");
	await demo.scrollIntoViewIfNeeded();
	await demo.hover();
	await expect(demo).toHaveAttribute("data-demo", "ready");
	return demo;
}

test.describe("live demo", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("opens messages, clears the unread dot and acts with undo, all without the network", async ({ page }) => {
		await page.goto("/");
		const demo = await liveDemo(page);
		// From here on nothing but same-origin assets (the dev server's modules, the logo) may be requested.
		const origin = new URL(page.url()).origin;
		const offending: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			const app = /^\/(api|jmap|mcp|\.well-known)(\/|$)/.test(url.pathname);
			if (url.origin !== origin || app || request.method() !== "GET")
				offending.push(`${request.method()} ${request.url()}`);
		});

		const lena = demo.getByRole("button", { name: /Unread Lena Fischer/ });
		await expect(lena).toBeVisible();
		await lena.click();
		await expect(
			demo.getByRole("heading", { level: 3, name: "Design review notes for the new onboarding" }),
		).toBeVisible();
		await expect(demo.getByText("I lean towards letting them skip it.")).toBeVisible();
		await expect(demo.getByRole("button", { name: /Unread Lena Fischer/ })).toHaveCount(0);
		await expect(demo.getByRole("button", { name: /^Lena Fischer/ })).toHaveAttribute("aria-current", "true");

		await demo.getByRole("button", { name: "Summarize" }).click();
		await expect(demo.getByTestId("demo-summary")).toContainText("Lena's review left two open points");

		await demo.getByRole("button", { name: "Archive" }).click();
		await expect(demo.getByRole("status")).toContainText("Archived");
		await expect(demo.getByRole("button", { name: /^Lena Fischer/ })).toHaveCount(0);
		await expect(demo.getByText("Select a message to read")).toBeVisible();
		await demo.getByRole("button", { name: "Undo" }).click();
		await expect(demo.getByRole("button", { name: /^Lena Fischer/ })).toBeVisible();
		await expect(demo.getByRole("status")).toHaveCount(0);

		// j and k move through the list from the keyboard (the click leaves the focus on Lena's row).
		await demo.getByRole("button", { name: /^Lena Fischer/ }).click();
		await page.keyboard.press("j");
		await expect(demo.getByRole("heading", { level: 3, name: "Quick question about the API" })).toBeVisible();
		await page.keyboard.press("k");
		await expect(
			demo.getByRole("heading", { level: 3, name: "Design review notes for the new onboarding" }),
		).toBeVisible();

		// Star, snooze and trash work from the toolbar, with the same undo.
		await demo.getByRole("button", { name: "Star", exact: true }).click();
		await expect(demo.getByRole("button", { name: "Unstar" })).toHaveAttribute("aria-pressed", "true");
		await demo.getByRole("button", { name: "Snooze", exact: true }).click();
		await expect(demo.getByRole("status")).toContainText("Snoozed until tomorrow");
		await demo.getByRole("button", { name: "Snoozed" }).click();
		await expect(
			demo.getByRole("list", { name: "Snoozed messages" }).getByText("Design review notes for the new onboarding"),
		).toBeVisible();
		await demo.getByRole("button", { name: "Starred" }).click();
		await expect(demo.getByRole("list", { name: "Starred messages" }).getByRole("listitem")).toHaveCount(2);
		await demo.getByRole("button", { name: /^Tom Okafor/ }).click();
		await demo.getByRole("button", { name: "Move to Trash" }).click();
		await expect(demo.getByRole("status")).toContainText("Moved to Trash");
		await expect(demo.getByRole("list", { name: "Starred messages" }).getByRole("listitem")).toHaveCount(1);
		await demo.getByRole("button", { name: "Undo" }).click();
		await expect(demo.getByRole("list", { name: "Starred messages" }).getByRole("listitem")).toHaveCount(2);

		// The module glimpses.
		await demo.getByRole("button", { name: "Calendar" }).click();
		await expect(demo.getByText("10:00 Planning session (offsite)")).toBeVisible();
		await demo.getByRole("button", { name: "Drive" }).click();
		await expect(demo.getByText("offsite-photo.jpg")).toBeVisible();
		await expect(demo.getByText("2.3 MB of 5 GB used")).toBeVisible();

		expect(offending).toEqual([]);
	});

	test("works from the keyboard with visible focus, and the dialogs take and give back the focus", async ({ page }) => {
		await page.goto("/");
		const demo = await liveDemo(page);
		await demo.getByRole("button", { name: /^Sofia Marchetti/ }).focus();
		await page.keyboard.press("Tab");
		const focused = demo.locator(":focus-visible");
		await expect(focused).toHaveCount(1);
		await expect(focused).toHaveAccessibleName(/^Unread Lena Fischer/);
		expect(await focused.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
		await page.keyboard.press("Enter");
		await expect(
			demo.getByRole("heading", { level: 3, name: "Design review notes for the new onboarding" }),
		).toBeVisible();

		const reply = demo.getByRole("button", { name: "Reply", exact: true });
		await reply.click();
		const composer = demo.getByRole("dialog", { name: "New message" });
		await expect(composer.getByLabel("To")).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(composer.getByLabel("Subject")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(composer).toHaveCount(0);
		await expect(reply).toBeFocused();

		const ai = demo.getByRole("button", { name: "Kite AI" });
		await ai.click();
		await expect(demo.getByRole("dialog", { name: "Kite AI" }).getByLabel("Ask about your mail")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(demo.getByRole("dialog", { name: "Kite AI" })).toHaveCount(0);
		await expect(ai).toBeFocused();
	});

	test("the Screener approves and denies new senders and the counts follow", async ({ page }) => {
		await page.goto("/");
		const demo = await liveDemo(page);
		const sidebar = demo.getByRole("complementary", { name: "Folders" });
		await expect(sidebar.getByRole("button", { name: "Screener 2" })).toBeVisible();
		await sidebar.getByRole("button", { name: "Screener 2" }).click();
		const rows = demo.getByRole("list", { name: "Screener messages" });
		await expect(rows.getByRole("listitem")).toHaveCount(2);

		await rows
			.getByRole("listitem")
			.filter({ hasText: "Ava Lindqvist" })
			.getByRole("button", { name: "Approve" })
			.click();
		await expect(demo.getByRole("status")).toContainText(
			"Approved. Mail from Ava Lindqvist now arrives in your Inbox.",
		);
		await expect(rows.getByRole("listitem")).toHaveCount(1);
		await expect(sidebar.getByRole("button", { name: "Screener 1" })).toBeVisible();

		await rows.getByRole("button", { name: "Deny" }).click();
		await expect(demo.getByRole("status")).toContainText("Denied. Mail from Jules Baptiste goes to Trash.");
		await expect(demo.getByText("Nothing here.")).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Screener" })).toBeVisible();
		await demo.getByRole("button", { name: "Undo" }).click();
		await expect(rows.getByRole("listitem")).toHaveCount(1);

		await sidebar.getByRole("button", { name: /^Inbox/ }).click();
		await expect(demo.getByText("New sender")).toHaveCount(1);
	});

	test("For you reviews the drafted reply in a composer that sends nothing, and dismisses the rest", async ({
		page,
	}) => {
		await page.goto("/");
		const demo = await liveDemo(page);
		await demo.getByRole("button", { name: "For you 3" }).click();
		await expect(demo.getByRole("region", { name: "Replies" })).toBeVisible();
		await demo.getByRole("button", { name: "Review draft" }).click();
		const composer = demo.getByRole("dialog", { name: "New message" });
		await expect(composer.getByText("Kite AI wrote this draft.")).toBeVisible();
		await expect(composer.getByLabel("Subject")).toHaveValue("Re: Launch plan for the new inbox");
		await expect(composer.getByLabel("Message")).toHaveValue(/Thanks Sofia, both files are in/);
		await composer.getByRole("button", { name: "Send" }).click();
		await expect(composer).toHaveCount(0);
		await expect(demo.getByRole("status")).toContainText("Demo: nothing sent");

		await demo.getByRole("button", { name: "Track" }).click();
		await expect(demo.getByRole("status")).toContainText("Tracking Fabrikam");
		await demo.getByRole("button", { name: "Accept" }).click();
		await demo.getByRole("button", { name: "Dismiss" }).first().click();
		await expect(demo.getByText("Nothing waiting for you.")).toBeVisible();
		await expect(demo.getByRole("button", { name: "For you" })).toBeVisible();

		await demo.getByRole("button", { name: "Subscriptions 1" }).click();
		await expect(demo.getByText("Fabrikam Team plan")).toBeVisible();
	});

	test("search filters the list, the update row goes away and the chat answers", async ({ page }) => {
		await page.goto("/");
		const demo = await liveDemo(page);
		await demo.getByRole("button", { name: "Reload" }).click();
		await expect(demo.getByText("Kite was updated")).toHaveCount(0);

		await demo.getByLabel("Search mail").fill("invoice");
		const rows = demo.getByRole("list", { name: "Inbox messages" });
		await expect(rows.getByRole("listitem")).toHaveCount(1);
		await expect(rows.getByText("Fabrikam Billing")).toBeVisible();
		await demo.getByLabel("Search mail").fill("zzz");
		await expect(demo.getByText('No mail matches "zzz".')).toBeVisible();
		await demo.getByLabel("Search mail").fill("");

		await demo.getByRole("button", { name: "Kite AI" }).click();
		const chat = demo.getByRole("dialog", { name: "Kite AI" });
		await chat.getByLabel("Ask about your mail").fill("What needs a reply today?");
		await chat.getByRole("button", { name: "Send" }).click();
		await expect(chat.getByText("Two messages need a reply today")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(chat).toHaveCount(0);
	});

	test("on a phone the demo shows one pane at a time with Back and a folder sheet", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/");
		const demo = await liveDemo(page);
		await expect(demo.getByRole("button", { name: "Summarize" })).toBeHidden();
		await demo.getByRole("button", { name: /Lena Fischer/ }).click();
		await expect(
			demo.getByRole("heading", { level: 3, name: "Design review notes for the new onboarding" }),
		).toBeVisible();
		await expect(demo.getByRole("list", { name: "Inbox messages" })).toBeHidden();
		await demo.getByRole("button", { name: "Back to list" }).click();
		await expect(demo.getByRole("list", { name: "Inbox messages" })).toBeVisible();
		await demo.getByRole("button", { name: "Open menu" }).click();
		await demo.getByRole("complementary", { name: "Folders" }).getByRole("button", { name: "Starred" }).click();
		await expect(demo.getByRole("list", { name: "Starred messages" }).getByRole("listitem")).toHaveCount(1);
		expect(await horizontalOverflow(page)).toBe(0);
	});
});

test.describe("signed in", () => {
	test("keeps the page and offers the dashboard", async ({ page }) => {
		await page.goto("/");
		const open = hero(page).getByRole("link", { name: "Open dashboard" });
		await expect(open).toHaveAttribute("href", "/inbox");
		await expect(hero(page).getByRole("link", { name: "Sign in" })).toHaveCount(0);
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveCount(0);
		await open.click();
		await expect(page).toHaveURL(/\/inbox$/);
	});
});
