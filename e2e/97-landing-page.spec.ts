import { expect, test, type Page } from "@playwright/test";
import { contrastBetween, luminancesBetween } from "./support/contrast";

// The landing page at `/`: what a visitor sees (the hero, the ways in, the feature grid and "how it runs"),
// what a signed-in user sees instead (the dashboard button), and that it holds up in dark mode and on a phone.

const SOURCE_URL = "https://github.com/midego1/kite";
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_URL}`;

function hero(page: Page) {
	return page.getByRole("region", { name: /that actually flows/ });
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
		await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mail for your own domains, that actually flows.");

		const heroSection = hero(page);
		const deploy = heroSection.getByRole("link", { name: "Deploy to Cloudflare" });
		await expect(deploy).toHaveAttribute("href", DEPLOY_URL);
		await expect(deploy).toHaveAttribute("target", "_blank");
		await expect(heroSection.getByRole("link", { name: "Self-host with Docker" })).toHaveAttribute(
			"href",
			`${SOURCE_URL}/blob/main/docs/self-hosting.md`,
		);
		await expect(heroSection.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
		await expect(heroSection.getByRole("link", { name: "Source on GitHub" })).toHaveAttribute("href", SOURCE_URL);
		await expect(heroSection.getByRole("link", { name: "Open dashboard" })).toHaveCount(0);
		await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

		// The preview is one described image for assistive technology, built from invented demo data.
		const preview = page.getByTestId("home-product-mock");
		await expect(preview).toBeVisible();
		await expect(preview).toHaveAttribute("role", "img");
		await expect(preview).toHaveAttribute("aria-label", /invented demo data/);
		await expect(preview.getByText("Kite was updated")).toBeVisible();
		await expect(preview.getByText("New sender")).toBeVisible();
		await expect(preview.getByText("launch-plan.pdf")).toBeVisible();
		await expect(preview.getByText("Reply drafted")).toBeVisible();

		await expect(
			page.getByRole("heading", { level: 2, name: "One quiet place for your mail and what comes with it." }),
		).toBeVisible();
		for (const title of [
			"A real inbox for you@yourdomain",
			"Your other accounts, in the same place",
			"AI that reads and drafts, and asks before it acts",
			"Calendar, Drive, Booking and more, as modules",
			"Backups and storage that scale",
			"JMAP, an API, webhooks and MCP",
			"Your data, on your account",
		]) {
			await expect(page.getByRole("heading", { level: 3, name: title })).toBeVisible();
		}
		const runtime = page.getByRole("region", { name: "Your account, your server, your copy of the code." });
		await expect(runtime.getByRole("link", { name: "Deploy to Cloudflare" })).toHaveAttribute("href", DEPLOY_URL);
		await expect(runtime.getByRole("link", { name: "Self-hosting guide" })).toBeVisible();
		await expect(runtime.getByRole("link", { name: "Source on GitHub" })).toHaveAttribute("href", SOURCE_URL);
		await expect(page.getByRole("contentinfo").getByRole("link", { name: "Source code" })).toHaveAttribute(
			"href",
			SOURCE_URL,
		);
		expect(await horizontalOverflow(page)).toBe(0);
	});

	test("Sign in from the hero opens the sign-in page", async ({ page }) => {
		await page.goto("/");
		await hero(page).getByRole("link", { name: "Sign in" }).click();
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
	});

	test("fits a phone without horizontal overflow", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		const heroSection = hero(page);
		await expect(heroSection.getByRole("link", { name: "Deploy to Cloudflare" })).toBeVisible();
		await expect(heroSection.getByRole("link", { name: "Sign in" })).toBeVisible();
		// The header keeps only Sign in on a phone; the deploy button lives in the hero.
		await expect(page.getByRole("banner").getByRole("link", { name: "Deploy to Cloudflare" })).toBeHidden();
		// The preview shows the message list alone, like the app on a phone.
		const preview = page.getByTestId("home-product-mock");
		await expect(preview.getByText("Design review notes for the new onboarding")).toBeVisible();
		await expect(preview.getByText("Summarize")).toBeHidden();
		expect(await horizontalOverflow(page)).toBe(0);
		await page
			.getByRole("heading", { level: 2, name: "Your account, your server, your copy of the code." })
			.scrollIntoViewIfNeeded();
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
