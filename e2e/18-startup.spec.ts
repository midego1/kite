import { expect, test } from "@playwright/test";
import { RELEASE_VERSION } from "./support/constants";

test("a stale offline hint cannot pause the session check indefinitely", async ({ page }) => {
	await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false }));
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByText(new RegExp(`Kite v${RELEASE_VERSION.replaceAll(".", "\\.")} \\([a-f0-9]{7}\\)`)),
	).toBeVisible();
	await expect(page.getByLabel("Loading", { exact: true })).not.toHaveClass(/opacity-100/);
});

test("preferences saved before the rename to Kite still apply", async ({ page }) => {
	await page.addInitScript(() => {
		if (sessionStorage.getItem("e2e-legacy-seeded")) return;
		sessionStorage.setItem("e2e-legacy-seeded", "1");
		localStorage.setItem("mailflare-theme", "dark");
		localStorage.setItem("mailflare-style", "classic");
	});
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("html")).toHaveClass(/\bdark\b/);
	await expect(page.locator("html")).toHaveAttribute("data-style", "classic");
	const stored = await page.evaluate(() => ({
		theme: localStorage.getItem("kite-theme"),
		style: localStorage.getItem("kite-style"),
		legacy: Object.keys(localStorage).filter((key) => key.startsWith("mailflare")),
	}));
	expect(stored).toEqual({ theme: "dark", style: "classic", legacy: [] });
});

test("a failed session check does not leave the startup overlay open", async ({ page }) => {
	await page.route("**/api/auth/me", (route) => route.abort("failed"));
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByLabel("Loading", { exact: true })).not.toHaveClass(/opacity-100/);
});

test("a stalled startup offers a reload without bypassing the session check", async ({ page }) => {
	await page.addInitScript(() => {
		// Simulate a browser where the request timeout itself fails.
		AbortSignal.timeout = () => new AbortController().signal;
	});
	let requests = 0;
	await page.route("**/api/auth/me", (route) => {
		requests += 1;
		if (requests > 1) return route.continue();
	});
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeHidden();
	await page.getByRole("button", { name: "Reload Kite" }).click({ timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible({ timeout: 15_000 });
	expect(requests).toBeGreaterThan(1);
});
