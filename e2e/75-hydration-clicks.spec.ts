import { expect, test, type Page } from "@playwright/test";
import { ADMIN } from "./support/constants";

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Holds every script until `release` is called, so the server-rendered page is on screen without React for as
 * long as the test needs: the window in which a click used to do nothing, or post the form natively.
 */
async function holdScripts(page: Page): Promise<() => void> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	await page.route("**/*", async (route) => {
		if (route.request().resourceType() === "script") await released;
		await route.continue();
	});
	return release;
}

test("an early click on Sign in waits for the page to become interactive and signs in", async ({ page }) => {
	const release = await holdScripts(page);
	// Module scripts hold back DOMContentLoaded, so only wait for the server's HTML.
	await page.goto("/login", { waitUntil: "commit" });

	const submit = page.getByRole("button", { name: "Sign in" });
	await expect(submit).toBeVisible();
	// Not interactive yet: disabled, without looking dimmed.
	await expect(submit).toBeDisabled();
	await expect(submit).toHaveAttribute("data-hydrating", "");
	expect(await submit.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("Password").fill(ADMIN.password);
	// The click is issued now and lands once the button is enabled; before, it posted the form to /login natively.
	const clicked = submit.click();
	release();
	await clicked;

	await expect(page).toHaveURL(/\/inbox/, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	expect(page.url()).not.toContain("password");
});

test("a click right after navigation is never lost on a public form", async ({ page }) => {
	const requests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/auth/") && request.method() === "POST")
			requests.push(new URL(request.url()).pathname);
	});
	// No wait for hydration: fill and click as soon as the controls exist.
	await page.goto("/forgot-password", { waitUntil: "commit" });
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByRole("button", { name: "Send reset link" }).click();

	await expect(page.getByText("If that account has a recovery email, a reset link is on its way.")).toBeVisible();
	// The request went through the app, not a native form submit that puts the address in the URL.
	expect(new URL(page.url()).search).toBe("");
	expect(requests).toHaveLength(1);
});
