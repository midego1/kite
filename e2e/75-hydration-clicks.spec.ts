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
	// Playwright issues the click once the button is enabled; before the fix it landed at once and posted the form
	// to /login natively. A person's click in that window is dropped by the browser instead.
	const clicked = submit.click();
	release();
	await clicked;

	await expect(page).toHaveURL(/\/inbox/, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	expect(page.url()).not.toContain("password");
});

/** Counts the app's reset requests and any navigation that carries the form in its URL. */
function watchResetRequests(page: Page) {
	const seen = { api: 0, nativeSubmits: [] as string[] };
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/api/auth/password-reset/request" && request.method() === "POST") seen.api += 1;
		if (request.isNavigationRequest() && url.searchParams.has("email")) seen.nativeSubmits.push(request.url());
	});
	return seen;
}

test("a click right after navigation on a public form waits for the page and goes through the app", async ({
	page,
}) => {
	const seen = watchResetRequests(page);
	const release = await holdScripts(page);
	await page.goto("/forgot-password", { waitUntil: "commit" });
	await page.getByLabel("Email").fill(ADMIN.email);
	const submit = page.getByRole("button", { name: "Send reset link" });
	await expect(submit).toBeDisabled();

	const clicked = submit.click();
	release();
	await clicked;

	await expect(page.getByText("If that account has a recovery email, a reset link is on its way.")).toBeVisible();
	// The request went through the app, not a native form submit that puts the address in the URL.
	expect(new URL(page.url()).search).toBe("");
	expect(seen.api).toBe(1);
	expect(seen.nativeSubmits).toEqual([]);
});

test("Enter in a field before the page is ready does not submit the form natively", async ({ page }) => {
	const seen = watchResetRequests(page);
	const release = await holdScripts(page);
	await page.goto("/forgot-password", { waitUntil: "commit" });
	const email = page.getByLabel("Email");
	await email.fill(ADMIN.email);
	await expect(page.getByRole("button", { name: "Send reset link" })).toBeDisabled();
	// Implicit submission needs an enabled default button, so this does nothing yet.
	await email.press("Enter");

	release();
	const submit = page.getByRole("button", { name: "Send reset link" });
	await expect(submit).toBeEnabled({ timeout: 30_000 });
	expect(seen.nativeSubmits).toEqual([]);
	expect(new URL(page.url()).search).toBe("");
	expect(seen.api).toBe(0);
	// The address typed before the page was ready is still there, and sending it works.
	await expect(email).toHaveValue(ADMIN.email);
	await submit.click();
	await expect(page.getByText("If that account has a recovery email, a reset link is on its way.")).toBeVisible();
	expect(seen.api).toBe(1);
});
