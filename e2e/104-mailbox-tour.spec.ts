import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, signIn, uniqueToken, waitForHydration } from "./support/helpers";

const PASSWORD = "mailbox-tour-password-1";

/**
 * The shared `signIn` helper dismisses the mailbox tour before it ever signs in, so every other spec that
 * signs in as a fresh account does not run into it. This test is about the tour itself, so it signs in the
 * same way `signIn` does but without that step, to see the real first-login state.
 */
async function signInWithoutDismissingTour(page: Page, email: string, password: string): Promise<void> {
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
}

async function createMailboxUser(username: string): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const { domains } = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;
	const response = await api.post("/api/accounts", { data: { username, domainId, password: PASSWORD, role: "user" } });
	expect(response.ok(), await response.text()).toBe(true);
	await api.dispose();
	return `${username}@${DOMAIN}`;
}

async function layoutFor(api: APIRequestContext): Promise<{ mailboxTourDismissed?: boolean }> {
	const response = await api.get("/api/settings/layout");
	expect(response.ok()).toBe(true);
	const data = (await response.json()) as { layout: { mailboxTourDismissed?: boolean } | null };
	return data.layout ?? {};
}

test.describe("the mailbox tour", () => {
	// A fresh browser: the default storage state is the suite's own owner, already signed in and past the tour.
	test.use({ storageState: { cookies: [], origins: [] } });

	test("a second user's first login opens it, skip ends it for good, and it replays from the account menu", async ({
		page,
	}) => {
		const email = await createMailboxUser(`tour${uniqueToken()}`);
		await signInWithoutDismissingTour(page, email, PASSWORD);
		await expect(page).toHaveURL(/\/inbox/);

		const dialog = page.getByTestId("mailbox-tour");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("Welcome to your mailbox")).toBeVisible();

		await dialog.getByRole("button", { name: "Skip tour" }).click();
		await expect(dialog).toBeHidden();

		const api = await apiSignIn(email, PASSWORD);
		expect((await layoutFor(api)).mailboxTourDismissed).toBe(true);

		// Dismissed for good: a reload does not bring it back on its own.
		await page.reload();
		await expect(page.getByTestId("mailbox-tour")).toHaveCount(0);

		// Replaying it from the account menu does not change the saved choice.
		await page.getByRole("button", { name: "Open account menu" }).click();
		await page.getByRole("button", { name: "Mailbox tour" }).click();
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("Welcome to your mailbox")).toBeVisible();

		for (const step of ["Screener", "For you", "Not phishing and trusted senders", "Conversation view"]) {
			await dialog.getByRole("button", { name: "Next" }).click();
			await expect(dialog.getByRole("heading", { name: step })).toBeVisible();
		}
		await dialog.getByRole("button", { name: "Done" }).click();
		await expect(dialog).toBeHidden();
		expect((await layoutFor(api)).mailboxTourDismissed).toBe(true);
		await api.dispose();
	});

	test("the owner never sees it, and the account menu offers no replay", async ({ page }) => {
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByTestId("mailbox-tour")).toHaveCount(0);
		await page.getByRole("button", { name: "Open account menu" }).click();
		await expect(page.getByRole("button", { name: "Mailbox tour" })).toHaveCount(0);
	});
});
