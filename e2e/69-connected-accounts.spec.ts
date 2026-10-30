import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption, expectSelectValue } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Connected accounts (docs/specs/external-accounts.md, PR 6): connect an IMAP account at the fake server on
// 127.0.0.1 (plain text is allowed only there, under EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK), import its mail
// without typing the password again, test, remove, the admin's install switch and per-user permission, and the
// page in every style. Each test uses its own user, since connection tests are limited per user.

const APP_PASSWORD = "fake-app-password";

type AccountView = { id: string; address: string; status: string; hasPassword: boolean };
type AccountsAnswer = { accounts: AccountView[]; refusal: string | null };

async function readAccounts(api: APIRequestContext): Promise<AccountsAnswer> {
	const response = await api.get("/api/external-accounts");
	expect(response.ok()).toBe(true);
	return (await response.json()) as AccountsAnswer;
}

async function userPage(browser: import("@playwright/test").Browser, api: APIRequestContext) {
	const context = await browser.newContext({ storageState: await api.storageState() });
	return { context, page: await context.newPage() };
}

/** Fills the connect dialog for the fake server; `password` is the account's. */
async function fillConnectDialog(page: Page, address: string, port: number, password: string) {
	const dialog = page.getByRole("dialog", { name: "Connect an account" });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Email address").fill(address);
	await dialog.getByLabel("Email address").blur();
	await chooseOption(dialog.locator("#external-provider"), "other");
	await dialog.locator("#external-imap-host").fill("127.0.0.1");
	await dialog.locator("#external-imap-port").fill(String(port));
	// Plain text is allowed only to this loopback fake, and only when STARTTLS is chosen and the server lacks it.
	await chooseOption(dialog.locator("#external-imap-security"), "starttls");
	await dialog.getByLabel("Password or app password").fill(password);
	await dialog.getByLabel("Your Kite password").fill(AUTO_READ_ACCOUNT_PASSWORD);
	return dialog;
}

test("an account is connected, imported from without its password, tested and removed while its mail stays", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const token = uniqueToken("xacct");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({
		authPlain: true,
		users: { [address]: APP_PASSWORD },
		folders: {
			INBOX: [sampleMessage(1, { subject: `${token} first` }), sampleMessage(2, { subject: `${token} second` })],
		},
	});
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `ca${token.slice(-8)}`);
	const { context, page } = await userPage(browser, user.api);
	try {
		await page.goto("/settings/connected-accounts");
		await expect(page.getByRole("heading", { name: "Connected accounts", level: 1 })).toBeVisible();
		await expect(page.getByText("No connected accounts")).toBeVisible();

		await page.getByRole("button", { name: "Connect account" }).click();
		let dialog = await fillConnectDialog(page, address, fake.port, "wrong-password");
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog.getByRole("alert")).toContainText("Sign-in failed");
		await expect(dialog.getByRole("alert")).not.toContainText("wrong-password");

		dialog = page.getByRole("dialog", { name: "Connect an account" });
		await dialog.getByLabel("Password or app password").fill(APP_PASSWORD);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("status").filter({ hasText: `Connected ${address}.` })).toBeVisible();
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row).toContainText("Connected");
		await expect(row).toContainText("Other IMAP provider");

		// The password never comes back from the API.
		const listed = await user.api.get("/api/external-accounts");
		expect(await listed.text()).not.toContain(APP_PASSWORD);
		const [account] = (await readAccounts(user.api)).accounts;
		expect(account).toMatchObject({ address, status: "active", hasPassword: true });

		// Import existing mail: the import page opens with the account chosen and no password field.
		await page.getByRole("link", { name: "Import existing mail" }).click();
		await expect(page).toHaveURL(new RegExp(`/settings/import\\?account=${account.id}`));
		await chooseOption(page.locator("#import-source"), { label: "IMAP" });
		await expectSelectValue(page.locator("#imap-account"), account.id);
		await expect(page.locator("#imap-password")).toHaveCount(0);
		await page.getByRole("button", { name: "Show folders" }).click();
		await expect(page.getByRole("table", { name: "Folders to import" })).toContainText("INBOX");
		await page.getByRole("button", { name: "Import account" }).click();
		await waitForMessage(user.api, `${token} first`);
		await waitForMessage(user.api, `${token} second`);
		const { jobs } = (await (await user.api.get("/api/import/jobs")).json()) as {
			jobs: { externalAccountId: string | null; status: string }[];
		};
		expect(jobs[0].externalAccountId).toBe(account.id);

		await page.goto("/settings/connected-accounts");
		await row.getByRole("button", { name: "Test connection" }).click();
		await expect(row.getByRole("status")).toHaveText("The connection works.");

		await row.getByRole("button", { name: "Remove" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
		await expect(row).toHaveCount(0);
		expect((await readAccounts(user.api)).accounts).toEqual([]);
		// Removing the account keeps its mail.
		await waitForMessage(user.api, `${token} first`);
	} finally {
		await context.close();
		await fake.close();
	}
});

test("connecting needs the Kite password, refuses Kite domains and private servers, and other users cannot use it", async () => {
	const token = uniqueToken("xref");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `cr${token.slice(-8)}`);
	const body = {
		address,
		preset: "other",
		mailboxId: user.mailboxId,
		imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
		password: APP_PASSWORD,
		kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
	};
	try {
		const wrongKite = await user.api.post("/api/external-accounts", { data: { ...body, kitePassword: "nope" } });
		expect(wrongKite.status()).toBe(400);
		expect((await wrongKite.json()).code).toBe("KITE_PASSWORD");
		const kiteDomain = await user.api.post("/api/external-accounts", {
			data: { ...body, address: `${token}@example.com` },
		});
		expect((await kiteDomain.json()).code).toBe("KITE_DOMAIN");
		const privateHost = await user.api.post("/api/external-accounts", {
			data: { ...body, imap: { host: "10.0.0.1", port: 993, security: "tls" } },
		});
		expect((await privateHost.json()).code).toBe("SERVER_REFUSED");
		const microsoft = await user.api.post("/api/external-accounts", { data: { ...body, preset: "microsoft" } });
		expect((await microsoft.json()).code).toBe("OAUTH_REQUIRED");

		const connected = await user.api.post("/api/external-accounts", { data: body });
		expect(connected.status()).toBe(201);
		const { account } = (await connected.json()) as { account: AccountView };
		// An "Other" account names its own server, so its address proves nothing: connecting it again is never
		// refused as taken (that would tell anyone running a server which addresses are connected here).
		const again = await user.api.post("/api/external-accounts", { data: body });
		expect(again.status()).toBe(201);

		// Another user cannot see, edit, test, remove or import from it.
		const otherUser = await createSignedInAccount(admin, `co${token.slice(-8)}`);
		expect((await readAccounts(otherUser.api)).accounts).toEqual([]);
		expect((await otherUser.api.patch(`/api/external-accounts/${account.id}`, { data: { label: "x" } })).status()).toBe(
			404,
		);
		expect((await otherUser.api.post(`/api/external-accounts/${account.id}/test`)).status()).toBe(404);
		expect((await otherUser.api.delete(`/api/external-accounts/${account.id}`)).status()).toBe(404);
		const plan = await otherUser.api.post("/api/import/account/plan", { data: { accountId: account.id } });
		expect(plan.status()).toBe(404);
		// Nothing without a session.
		const anonymous = await apiContext();
		expect((await anonymous.get("/api/external-accounts")).status()).toBe(401);
	} finally {
		await fake.close();
	}
});

test("the admin's install switch and per-user permission pause connected accounts", async ({ page }) => {
	test.setTimeout(90_000);
	const token = uniqueToken("xadm");
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `cp${token.slice(-8)}`);
	try {
		const install = (await (await admin.get("/api/admin/external-accounts")).json()) as {
			enabled: boolean;
			keyConfigured: boolean;
		};
		expect(install).toMatchObject({ enabled: true, keyConfigured: true });
		// Only the owner may change the install switch.
		expect((await user.api.get("/api/admin/external-accounts")).status()).toBe(403);

		const revoked = await admin.put(`/api/admin/accounts/${user.id}/connected-accounts`, { data: { allowed: false } });
		expect(revoked.ok()).toBe(true);
		expect((await readAccounts(user.api)).refusal).toBe("not_permitted");
		expect((await user.api.post("/api/external-accounts", { data: {} })).status()).toBe(403);

		await page.goto(`/accounts/${user.id}/permissions`);
		const section = page.getByRole("region", { name: "Connected accounts" });
		const allow = section.getByRole("checkbox", { name: "Allow connected accounts" });
		await expect(allow).not.toBeChecked();
		await allow.click();
		await expect(section.getByRole("status")).toHaveText("Connected accounts allowed");
		expect((await readAccounts(user.api)).refusal).toBeNull();

		expect((await admin.put("/api/admin/external-accounts", { data: { enabled: false } })).ok()).toBe(true);
		expect((await readAccounts(user.api)).refusal).toBe("install_off");
		await page.goto("/general");
		const card = page.locator("[data-connected-accounts-switch]");
		await expect(card.getByRole("switch", { name: "Allow connected accounts" })).not.toBeChecked();
		await expect(card).toContainText("passwords are erased 30 days after");
		await card.getByRole("switch", { name: "Allow connected accounts" }).click();
		await expect(card.getByRole("switch", { name: "Allow connected accounts" })).toBeChecked();
		expect((await readAccounts(user.api)).refusal).toBeNull();
	} finally {
		await admin.put("/api/admin/external-accounts", { data: { enabled: true } });
		await admin.put(`/api/admin/accounts/${user.id}/connected-accounts`, { data: { allowed: true } });
	}
});

test("the Connected accounts page reads in Kite, Kite light, Classic and dark mode", async ({ browser }, testInfo) => {
	test.setTimeout(120_000);
	const token = uniqueToken("xsty");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `cs${token.slice(-8)}`);
	const variants = [
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "lavender-light", style: "lavender", theme: "light" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	];
	try {
		const connected = await user.api.post("/api/external-accounts", {
			data: {
				address,
				label: `Archive ${token}`,
				preset: "other",
				mailboxId: user.mailboxId,
				imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
				password: APP_PASSWORD,
				kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
			},
		});
		expect(connected.status()).toBe(201);
		for (const variant of variants) {
			const { context, page } = await userPage(browser, user.api);
			try {
				await page.addInitScript(({ style, theme }) => {
					localStorage.setItem("kite-style", style);
					localStorage.setItem("kite-theme", theme);
				}, variant);
				await page.goto("/settings/connected-accounts");
				await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
				const label = page.getByText(`Archive ${token}`, { exact: true });
				await expect(label).toBeVisible();
				const [text, background] = await label.evaluate((element) => {
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
					return [luminance(getComputedStyle(element).color), luminance(fill)];
				});
				expect(Math.abs(text - background), variant.name).toBeGreaterThan(100);
				await page.screenshot({ path: testInfo.outputPath(`connected-accounts-${variant.name}.png`) });
				await page.getByRole("button", { name: "Connect account" }).click();
				const dialog = page.getByRole("dialog", { name: "Connect an account" });
				await expect(dialog).toHaveCSS("opacity", "1");
				await page.screenshot({ path: testInfo.outputPath(`connect-dialog-${variant.name}.png`) });
			} finally {
				await context.close();
			}
		}
	} finally {
		await fake.close();
	}
});
