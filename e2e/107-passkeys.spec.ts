import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken, waitForHydration } from "./support/helpers";
import { addVirtualAuthenticator, storedCredentials, totpCode } from "./support/passkeys";

const PASSWORD = "passkey-e2e-password";

test.use({ storageState: { cookies: [], origins: [] } });

async function createUser(): Promise<{ id: string; email: string }> {
	const admin = await apiContext(STORAGE_STATE);
	const domains = (await (await admin.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const username = uniqueToken("passkey");
	const created = await admin.post("/api/accounts", {
		data: {
			username,
			domainId: domains.domains.find((domain) => domain.hostname === DOMAIN)!.id,
			password: PASSWORD,
			role: "user",
			useAllDomains: false,
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const { account } = (await created.json()) as { account: { id: string } };
	await admin.dispose();
	return { id: account.id, email: `${username}@${DOMAIN}` };
}

/** Turns on TOTP through the same routes the Security page uses, so a password sign-in would ask for a code. */
async function turnOnTotp(page: Page): Promise<void> {
	const headers = { Origin: BASE_URL };
	const enrolled = await page.request.post("/api/settings/mfa/enroll", { headers, data: { password: PASSWORD } });
	expect(enrolled.ok(), await enrolled.text()).toBe(true);
	const { secret } = (await enrolled.json()) as { secret: string };
	const confirmed = await page.request.post("/api/settings/mfa/confirm", { headers, data: { code: totpCode(secret) } });
	expect(confirmed.ok(), await confirmed.text()).toBe(true);
}

async function signOut(page: Page): Promise<void> {
	await page.request.post("/api/auth/logout", { headers: { Origin: BASE_URL } });
	await page.goto("/login");
	await waitForHydration(page);
}

async function addPasskey(page: Page, name: string): Promise<void> {
	await page.goto("/settings/security");
	await page.getByRole("button", { name: "Add a passkey" }).click();
	const dialog = page.getByRole("dialog", { name: "Add a passkey" });
	await dialog.getByLabel("Name (optional)").fill(name);
	// Two-factor is on, so the dialog also offers a code; the password works on its own.
	await expect(dialog.getByRole("button", { name: "Use an authenticator code instead" })).toBeVisible();
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Continue" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("list", { name: "Your passkeys" }).getByText(name)).toBeVisible();
}

test("register a passkey, sign in with it instead of password and code, remove it, and an admin reset", async ({
	page,
}) => {
	const user = await createUser();
	const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

	await signIn(page, user.email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	await turnOnTotp(page);

	// Register: the password is asked again, the browser creates a discoverable credential.
	await addPasskey(page, "E2E laptop");
	await expect(page.getByText("Not used yet")).toBeVisible();
	const [credential] = await storedCredentials(cdp, authenticatorId);
	expect(credential.isResidentCredential).toBe(true);
	expect(credential.rpId).toBe("localhost");

	// Sign out, then in with the passkey: no password and, although TOTP is on, no code.
	await signOut(page);
	await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expect(page).toHaveURL(/\/inbox/);
	await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toHaveCount(0);

	// The list shows it was used; removing it asks for the password again.
	await page.goto("/settings/security");
	const list = page.getByRole("list", { name: "Your passkeys" });
	await expect(list.getByText(/Last used/)).toBeVisible();
	await list.getByRole("button", { name: "Remove E2E laptop" }).click();
	const remove = page.getByRole("dialog", { name: "Remove E2E laptop" });
	await remove.getByLabel("Password").fill("not-the-password");
	await remove.getByRole("button", { name: "Remove passkey" }).click();
	await expect(remove.getByRole("alert")).toHaveText("Password is incorrect");
	await remove.getByLabel("Password").fill(PASSWORD);
	await remove.getByRole("button", { name: "Remove passkey" }).click();
	await expect(remove).toBeHidden();
	await expect(list).toHaveCount(0);

	// The browser still holds the removed passkey; Kite refuses it.
	await signOut(page);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expect(page.getByRole("alert")).toContainText("This passkey is not registered here");
	await expect(page).toHaveURL(/\/login/);

	// An admin's reset of the second factors removes passkeys too.
	await signIn(page, user.email, PASSWORD);
	await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
	const admin = await apiContext(STORAGE_STATE);
	const firstReset = await admin.delete(`/api/accounts/${user.id}/mfa`);
	expect(firstReset.ok(), await firstReset.text()).toBe(true);
	expect(await firstReset.json()).toMatchObject({ ok: true, passkeysRemoved: 0 });
	await admin.dispose();
	await page.getByRole("button", { name: "Back to sign in" }).click();
	await signIn(page, user.email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	await addPasskeyWithoutTotp(page, "Second laptop");
	const resetAdmin = await apiContext(STORAGE_STATE);
	const reset = await resetAdmin.delete(`/api/accounts/${user.id}/mfa`);
	expect(await reset.json()).toMatchObject({ ok: true, passkeysRemoved: 1 });
	await resetAdmin.dispose();
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expect(page.getByRole("alert")).toContainText("This passkey is not registered here");
});

async function addPasskeyWithoutTotp(page: Page, name: string): Promise<void> {
	await page.goto("/settings/security");
	await page.getByRole("button", { name: "Add a passkey" }).click();
	const dialog = page.getByRole("dialog", { name: "Add a passkey" });
	await dialog.getByLabel("Name (optional)").fill(name);
	await expect(dialog.getByRole("button", { name: "Use an authenticator code instead" })).toHaveCount(0);
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByRole("list", { name: "Your passkeys" }).getByText(name)).toBeVisible();
}
