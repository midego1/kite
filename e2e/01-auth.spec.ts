import { expect, test } from "@playwright/test";
import { ADMIN, BASE_URL } from "./support/constants";
import { contrastBetween } from "./support/contrast";
import { apiSignIn, signIn } from "./support/helpers";

test.describe("authentication", () => {
	// These tests sign in and out on their own, so they must not share (and revoke) the suite's admin session.
	test.use({ storageState: { cookies: [], origins: [] } });

	test("the sign-in card reads at WCAG AA in Kite, Classic and dark mode", async ({ page }) => {
		for (const [style, theme] of [
			["kite", "light"],
			["classic", "light"],
			["kite", "dark"],
			["lavender", "dark"],
		] as const) {
			await page.addInitScript(
				([nextStyle, nextTheme]) => {
					localStorage.setItem("kite-style", nextStyle);
					localStorage.setItem("kite-theme", nextTheme);
				},
				[style, theme],
			);
			await page.goto("/login");
			const heading = page.getByRole("heading", { level: 1, name: "Sign in" });
			await expect(heading).toBeVisible();
			const card = page.locator("main section").first();
			const label = `${style} ${theme}`;
			expect(await contrastBetween(heading, card), `${label} title`).toBeGreaterThanOrEqual(4.5);
			expect(await contrastBetween(card.locator("p").first(), card), `${label} description`).toBeGreaterThanOrEqual(
				4.5,
			);
			const forgot = page.getByRole("link", { name: "Forgot password?" });
			expect(await contrastBetween(forgot, card), `${label} link`).toBeGreaterThanOrEqual(4.5);
			const button = page.getByRole("button", { name: "Sign in" });
			expect(await contrastBetween(button), `${label} button`).toBeGreaterThanOrEqual(4.5);
		}
	});

	test("rejects a wrong password and stays on the login page", async ({ page }) => {
		await signIn(page, ADMIN.email, "not-the-password");
		await expect(page.getByText("Invalid credentials")).toBeVisible();
		await expect(page).toHaveURL(/\/login/);
		const cookies = await page.context().cookies();
		expect(cookies.find((cookie) => cookie.name === "ep_session")).toBeUndefined();
	});

	test("signs in, keeps the session across a reload and signs out", async ({ page }) => {
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("link", { name: /Cannot access workspace/ })).toBeVisible();

		await page.reload();
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("link", { name: /Cannot access workspace/ })).toBeVisible();

		await page.getByRole("button", { name: "Open account menu" }).click();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL(/\/login/);
		await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

		// The session is revoked server-side, not just forgotten by the browser.
		const me = await page.request.get("/api/auth/me");
		expect(me.status()).toBe(401);
		await page.goto("/inbox");
		await expect(page).toHaveURL(/\/login/);
	});

	test("signs in again after the server revoked the session behind the page", async ({ page }) => {
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await page.goto("/backups");
		await expect(page.getByRole("heading", { name: "Database Backups" })).toBeVisible();

		// What a restore or an admin password reset does: the cookie dies, the tab still remembers the user.
		await page.request.post("/api/auth/logout", { headers: { Origin: BASE_URL } });
		// Any background request of the open page that now answers 401 sends it to /login by itself (authFetch), at a
		// moment we do not control. A script run in the page then loses its execution context, and a goto of ours is
		// aborted when that redirect wins, so navigate from the test side and treat "aborted" as "already on its way".
		await page.goto("/login").catch((error: Error) => {
			if (!error.message.includes("net::ERR_ABORTED")) throw error;
		});
		await expect(page).toHaveURL(/\/login/);

		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("main").getByText("Cannot access workspace", { exact: true }).first()).toBeVisible();
	});

	test("sends an expired session to the sign-in page when a screen loads its data", async ({ page }) => {
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await page.getByRole("button", { name: "Create folder" }).click();
		await page.getByLabel("Folder name").fill("Expired session folder");

		// The cookie dies server-side while the tab keeps running; the next data request answers 401.
		await page.request.post("/api/auth/logout", { headers: { Origin: BASE_URL } });
		await page.getByRole("dialog").getByRole("button", { name: "Create folder" }).click();
		await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
		await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	});

	test("rejects session mutations from a foreign origin", async () => {
		const api = await apiSignIn(ADMIN.email, ADMIN.password);
		const mutation = { data: { name: "should not exist", mailboxIds: [], scopes: ["mcp:calendar-read"] } };

		// The dev server's own origin guard answers for unrelated hosts.
		const foreign = await api.post("/api/agent/mcp-keys", { ...mutation, headers: { Origin: "https://evil.test" } });
		expect(foreign.status()).toBe(403);

		// A *.localhost origin passes the dev guard, so this exercises the app's CSRF check itself.
		const lookalike = await api.post("/api/auth/logout", {
			headers: { Origin: `http://evil.localhost:${new URL(BASE_URL).port}` },
		});
		expect(lookalike.status()).toBe(403);
		expect(await lookalike.json()).toEqual({ error: "Cross-site request blocked" });

		const crossSite = await api.post("/api/auth/logout", {
			headers: { Origin: "", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
		});
		expect(crossSite.status()).toBe(403);

		// None of the rejected requests signed the user out.
		expect((await api.get("/api/auth/me")).status()).toBe(200);
		const keys = (await (await api.get("/api/agent/mcp-keys")).json()) as { keys: { name: string }[] };
		expect(keys.keys.map((key) => key.name)).not.toContain("should not exist");
		await api.dispose();
	});
});
