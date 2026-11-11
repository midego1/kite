import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { FAKE_MICROSOFT_OAUTH_PORT, STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, suppressMailboxTour, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";
import { startFakeGoogleOAuth } from "../tests/support/fake-google-oauth.mjs";
import { startFakeSmtp } from "../tests/support/fake-smtp.mjs";

// Sign in with Google (docs/specs/external-accounts.md §15.7, ROADMAP milestone 6 item 4): the owner saves the
// install's Google Cloud OAuth client in Admin → General (checked against the fake token endpoint, a wrong secret
// refused); a user connects a Gmail account with **Sign in with Google**, which goes through the fake authorize page
// (EXTERNAL_OAUTH_TEST_ORIGIN under /google, dev only) and back; the app password stays one click away; new mail
// arrives over IMAP XOAUTH2; mail sent as the address goes through SMTP XOAUTH2; a revoked sign-in shows Sign-in
// failed, and Reconnect signs in again. The fake issues tokens that live one minute, so every use renews one.

const RECIPIENT = "friend@e2e.test";

type AccountView = { id: string; address: string; status: string; authKind: string };

async function readAccounts(api: APIRequestContext): Promise<AccountView[]> {
	const response = await api.get("/api/external-accounts");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { accounts: AccountView[] }).accounts;
}

/** The fakes' loopback servers go with the start request; only the test origin lets the server accept them. */
async function routeToFakes(page: Page, imapPort: number, smtpPort: number) {
	await page.route("**/api/external-accounts/oauth/start", async (route) => {
		const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		await route.continue({
			postData: JSON.stringify({
				...body,
				testServers: {
					imap: { host: "127.0.0.1", port: imapPort, security: "starttls" },
					smtp: { host: "127.0.0.1", port: smtpPort, security: "starttls" },
				},
			}),
		});
	});
}

test("the owner sets up Google sign-in; a user connects Gmail, receives, sends, loses the sign-in and reconnects", async ({
	browser,
	page: adminPage,
}) => {
	test.setTimeout(240_000);
	const token = uniqueToken("gooauth");
	const address = `${token}@gmail.com`;
	const accessTokens: Record<string, string> = {};
	const oauth = await startFakeGoogleOAuth({
		port: FAKE_MICROSOFT_OAUTH_PORT,
		account: { address, sub: `1${Date.now()}` },
		expiresIn: 60,
		onAccessToken: (user: string, value: string) => {
			accessTokens[user] = value;
		},
	});
	const imap = await startFakeImap({
		saslIr: true,
		accessTokens,
		folders: { INBOX: [sampleMessage(1, { subject: `${token} before connecting` })], Sent: [] },
	});
	const smtp = await startFakeSmtp({ authMethods: ["XOAUTH2"], accessTokens });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `gg${token.slice(-8)}`);
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	const page = await context.newPage();
	await suppressMailboxTour(page);
	try {
		// The owner: a wrong secret is refused with Google's reason, the right one saved and never shown again.
		await adminPage.goto("/general");
		const card = adminPage.locator("[data-google-sign-in-settings]");
		await expect(card).toBeVisible({ timeout: 60_000 });
		await expect(card.getByLabel("Authorized redirect URI")).toHaveValue(/\/api\/external-accounts\/oauth\/callback$/);
		await card.getByLabel("Client ID").fill(oauth.clientId);
		await card.getByLabel("Client secret").fill("GOCSPX-not-this-one");
		await card.getByRole("button", { name: "Save" }).click();
		await expect(card.getByRole("alert")).toContainText("Google refused the client secret");
		await card.getByLabel("Client secret").fill(oauth.clientSecret);
		await card.getByRole("button", { name: "Save" }).click();
		await expect(card.getByRole("status")).toHaveText(
			"Saved. Users can now connect Google accounts with Sign in with Google.",
		);
		await expect(card.locator("[data-google-sign-in-status]")).toHaveText(
			`On: client ${oauth.clientId}, any Google account.`,
		);
		const status = await admin.get("/api/admin/external-accounts/google");
		expect(await status.text()).not.toContain(oauth.clientSecret);

		// The user: Sign in with Google instead of a password field, with the app password one click away.
		await routeToFakes(page, imap.port, smtp.port);
		await page.goto("/settings/connected-accounts");
		// A cold dev server shows its loading overlay over the page for a while; wait until the page has its data.
		await page.waitForLoadState("load");
		await expect(page.getByText("No connected accounts")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Connect account" }).click();
		const dialog = page.getByRole("dialog", { name: "Connect an account" });
		await dialog.getByLabel("Email address").fill(address);
		await chooseOption(dialog.locator("#external-provider"), "gmail");
		await expect(dialog.getByLabel("Password or app password")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Use an app password instead" }).click();
		await expect(dialog.getByLabel("Password or app password")).toBeVisible();
		await dialog.getByRole("button", { name: "Sign in with Google instead" }).click();
		await expect(dialog.getByLabel("Password or app password")).toHaveCount(0);
		const signIn = dialog.getByRole("button", { name: "Sign in with Google" });
		await expect(signIn).toBeDisabled();
		await dialog.getByLabel("Your Kite password").fill(AUTO_READ_ACCOUNT_PASSWORD);
		await signIn.click();
		// Google's (fake) page consents and sends the browser back through the callback.
		await page.waitForURL(/\/settings\/connected-accounts$/, { timeout: 60_000 });
		await expect(page.getByText("Google account connected.")).toBeVisible();
		const authorize = oauth.requests.find((entry: { kind: string }) => entry.kind === "authorize");
		expect(authorize?.params).toMatchObject({
			code_challenge_method: "S256",
			access_type: "offline",
			prompt: "consent",
			scope: "https://mail.google.com/ openid email",
			login_hint: address,
		});
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row).toContainText("Gmail");
		const [account] = await readAccounts(user.api);
		expect(account).toMatchObject({ address, status: "active", authKind: "oauth_google" });
		expect(imap.commands.some((entry) => entry.line.includes("AUTHENTICATE XOAUTH2"))).toBe(true);
		expect(smtp.auths.some((entry) => entry.method === "XOAUTH2" && entry.username === address)).toBe(true);

		// New mail arrives over IMAP with a renewed token; mail from before connecting stays out.
		imap.addMessage("INBOX", sampleMessage(2, { subject: `${token} after connecting` }));
		await row.getByRole("button", { name: "Check now" }).click();
		await waitForMessage(user.api, `${token} after connecting`);
		expect(
			oauth.requests.filter((entry: { kind: string; grant?: string }) => entry.grant === "refresh_token").length,
		).toBeGreaterThan(0);

		// Mail sent as the address goes through Gmail's SMTP server with XOAUTH2.
		await page.goto("/inbox");
		// The inbox shows its loading screen for a while on a busy dev server.
		const compose = page.getByRole("button", { name: "Compose" });
		await expect(compose).toBeVisible({ timeout: 60_000 });
		await compose.click();
		await chooseOption(page.getByRole("combobox", { name: "From" }), { label: `${address} (via Gmail)` });
		const to = page.getByLabel("To", { exact: true });
		await to.fill(RECIPIENT);
		await to.press("Enter");
		const subject = `Sent through Gmail ${token}`;
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("textbox", { name: "Message body" }).fill("Hello from a Google account.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByText("Message sent")).toBeVisible();
		await expect.poll(() => smtp.messages.length, { timeout: 30_000 }).toBe(1);
		expect(smtp.messages[0].from).toBe(address);
		await waitForMessage(user.api, subject, { status: "sent" });

		// The user removes Kite at Google: the next check stops the account with Sign-in failed and Reconnect.
		oauth.revokeAll();
		await page.goto("/settings/connected-accounts");
		await row.getByRole("button", { name: "Test connection" }).click();
		await expect(row).toContainText("Google sign-in expired or was revoked. Reconnect to sign in with Google again.");
		expect((await readAccounts(user.api))[0].status).toBe("auth_failed");

		// Reconnect: sign in with Google again, as the same account.
		await row.getByRole("button", { name: "Reconnect" }).click();
		const edit = page.getByRole("dialog", { name: `Edit ${address}` });
		const again = edit.getByRole("button", { name: "Sign in with Google again" });
		await expect(again).toBeDisabled();
		await edit.getByLabel("Your Kite password").fill(AUTO_READ_ACCOUNT_PASSWORD);
		await again.click();
		await page.waitForURL(/\/settings\/connected-accounts$/, { timeout: 60_000 });
		await expect(page.getByText("Google account reconnected.")).toBeVisible();
		await expect.poll(async () => (await readAccounts(user.api))[0].status).toBe("active");

		// A sign-in that was cancelled at Google connects nothing and says so.
		oauth.denyNext();
		await page.getByRole("button", { name: "Connect account" }).click();
		const second = page.getByRole("dialog", { name: "Connect an account" });
		await second.getByLabel("Email address").fill(`other-${address}`);
		await chooseOption(second.locator("#external-provider"), "gmail");
		await second.getByLabel("Your Kite password").fill(AUTO_READ_ACCOUNT_PASSWORD);
		await second.getByRole("button", { name: "Sign in with Google" }).click();
		await page.waitForURL(/\/settings\/connected-accounts$/, { timeout: 60_000 });
		await expect(page.getByText("The Google sign-in was cancelled. Nothing was connected.")).toBeVisible();
		expect(await readAccounts(user.api)).toHaveLength(1);
	} finally {
		await context.close();
		await admin.delete("/api/admin/external-accounts/google").catch(() => undefined);
		await Promise.all([oauth.close(), imap.close(), smtp.close()]);
	}
});
