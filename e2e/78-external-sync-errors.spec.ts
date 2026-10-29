import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Connected accounts, sync errors (docs/specs/external-accounts.md §6.5, PR 7): the password changes at the fake
// IMAP server, **Check now** marks the account "Sign-in failed", the sidebar notice says so and links to Reconnect,
// reconnecting with the new password brings the mail in again and the notice goes. The notice and the account row
// are checked in Kite (dark and light), Classic (light and dark) for contrast.

const APP_PASSWORD = "fake-app-password";
const NEW_PASSWORD = "rotated-app-password";

type AccountView = { id: string; status: string; lastError: string | null };

async function readAccount(api: APIRequestContext): Promise<AccountView> {
	const response = await api.get("/api/external-accounts");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { accounts: AccountView[] }).accounts[0];
}

/** The luminance gap between an element's text and the first opaque background behind it. */
async function contrast(locator: Locator): Promise<number> {
	return locator.evaluate((element) => {
		const canvas = document.createElement("canvas").getContext("2d")!;
		const luminance = (color: string) => {
			canvas.clearRect(0, 0, 1, 1);
			canvas.fillStyle = color;
			canvas.fillRect(0, 0, 1, 1);
			const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		let node: Element | null = element;
		let fill = "rgba(0, 0, 0, 0)";
		while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(fill)) {
			fill = getComputedStyle(node).backgroundColor;
			node = node.parentElement;
		}
		return Math.abs(luminance(getComputedStyle(element).color) - luminance(fill));
	});
}

test("a failed sign-in stops sync, shows in the sidebar and is fixed by reconnecting", async ({
	browser,
}, testInfo) => {
	test.setTimeout(180_000);
	const token = uniqueToken("xfail");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD }, folders: { INBOX: [] } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sf${token.slice(-8)}`);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	const page = await context.newPage();
	try {
		const connected = await user.api.post("/api/external-accounts", {
			data: {
				address,
				preset: "other",
				mailboxId: user.mailboxId,
				imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
				password: APP_PASSWORD,
				kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
			},
		});
		expect(connected.status()).toBe(201);
		fake.setPassword(address, NEW_PASSWORD);
		fake.addMessage("INBOX", sampleMessage(1, { subject: `${token} after the reconnect` }));

		await page.goto("/settings/connected-accounts");
		const row = page.locator(`[data-external-account="${address}"]`);
		await row.getByRole("button", { name: "Check now" }).click();
		await expect(row).toContainText("Sign-in failed", { timeout: 45_000 });
		const account = await readAccount(user.api);
		expect(account.status).toBe("auth_failed");
		expect(account.lastError).not.toContain(APP_PASSWORD);
		await expect(row.getByRole("button", { name: "Check now" })).toHaveCount(0);

		// The sidebar notice names the account and links to Reconnect.
		await page.goto("/inbox");
		const notice = page.getByRole("status", { name: "Connected accounts" });
		await expect(notice).toContainText(`Sign-in failed for ${address}`, { timeout: 60_000 });
		await page.screenshot({ path: testInfo.outputPath("sync-notice.png") });
		await notice.getByRole("link", { name: "Reconnect" }).click();
		await expect(page).toHaveURL(/\/settings\/connected-accounts$/);

		await row.getByRole("button", { name: "Reconnect" }).click();
		const dialog = page.getByRole("dialog", { name: `Edit ${address}` });
		await dialog.getByLabel("Password or app password").fill(NEW_PASSWORD);
		await dialog.getByLabel("Your Kite password").fill(AUTO_READ_ACCOUNT_PASSWORD);
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toBeHidden();
		await expect(row.getByText("Connected", { exact: true })).toBeVisible();

		await row.getByRole("button", { name: "Check now" }).click();
		await waitForMessage(user.api, `${token} after the reconnect`);
		await page.goto("/inbox");
		await expect(page.getByRole("status", { name: "Connected accounts" })).toHaveCount(0);
	} finally {
		await context.close();
		await fake.close();
	}
});

test("the sync notice and the account's state read in Kite, Kite light, Classic and dark mode", async ({
	browser,
}, testInfo) => {
	test.setTimeout(150_000);
	const token = uniqueToken("xnot");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD }, folders: { INBOX: [] } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sn${token.slice(-8)}`);
	const variants = [
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	];
	try {
		const connected = await user.api.post("/api/external-accounts", {
			data: {
				address,
				preset: "other",
				mailboxId: user.mailboxId,
				imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
				password: APP_PASSWORD,
				kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
			},
		});
		const { account } = (await connected.json()) as { account: AccountView };
		fake.setPassword(address, NEW_PASSWORD);
		expect((await user.api.post(`/api/external-accounts/${account.id}/sync`)).status()).toBe(202);
		await expect.poll(async () => (await readAccount(user.api)).status, { timeout: 45_000 }).toBe("auth_failed");
		for (const variant of variants) {
			const context = await browser.newContext({ storageState: await user.api.storageState() });
			try {
				const page = await context.newPage();
				await page.addInitScript(({ style, theme }) => {
					localStorage.setItem("kite-style", style);
					localStorage.setItem("kite-theme", theme);
				}, variant);
				await page.goto("/inbox");
				await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
				const title = page
					.getByRole("status", { name: "Connected accounts" })
					.getByText(`Sign-in failed for ${address}`);
				await expect(title).toBeVisible({ timeout: 60_000 });
				expect(await contrast(title), variant.name).toBeGreaterThan(60);
				await page.screenshot({ path: testInfo.outputPath(`sync-notice-${variant.name}.png`) });
				await page.goto("/settings/connected-accounts");
				const hint = page
					.locator(`[data-external-account="${address}"]`)
					.getByText("Sign-in failed. Reconnect with the current (app) password.");
				await expect(hint).toBeVisible({ timeout: 60_000 });
				expect(await contrast(hint), variant.name).toBeGreaterThan(60);
				await page.screenshot({ path: testInfo.outputPath(`sync-account-${variant.name}.png`) });
			} finally {
				await context.close();
			}
		}
	} finally {
		await fake.close();
	}
});
