import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { turnScreenerOff } from "./support/screener";
import { chooseOption, expectSelectValue, readOptions } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// "New mailbox for this account" in the connect dialog: a suggested, editable name on a domain the person may use,
// created through the normal mailbox route and then connected; a failed connect leaves a clear notice with reuse or
// delete; people who may not create mailboxes see nothing new; the import page starts in the account's mailbox; and
// Edit can still move an account's mail to another mailbox.

const APP_PASSWORD = "fake-app-password";

type MailboxRow = { id: string; localPart: string; hostname: string };

async function mailboxesOf(api: APIRequestContext): Promise<MailboxRow[]> {
	const response = await api.get("/api/mailboxes");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { mailboxes: MailboxRow[] }).mailboxes;
}

/** A member who may manage mailboxes (the admin's domains are theirs to use) with a signed-in page. */
async function mailboxManager(browser: Browser, name: string, canManageMailboxes: boolean) {
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, name);
	const response = await admin.patch(`/api/accounts/${user.id}`, {
		data: { name, role: "user", disabled: false, canManageMailboxes, canManageDomains: false },
	});
	expect(response.ok()).toBe(true);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	return { user, context, page: await context.newPage() };
}

async function openConnectDialog(page: Page, address: string, port: number, password: string) {
	await page.goto("/settings/connected-accounts");
	await page.getByRole("button", { name: "Connect account" }).click();
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

test("a mailbox of its own is suggested, created, connected and the import starts in it", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("mb");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({
		authPlain: true,
		users: { [address]: APP_PASSWORD },
		folders: { INBOX: [sampleMessage(1, { subject: `${token} first` })] },
	});
	const { user, context, page } = await mailboxManager(browser, `mb${token.slice(-8)}`, true);
	try {
		const dialog = await openConnectDialog(page, address, fake.port, APP_PASSWORD);
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		// The name comes from the address and the provider, and can be changed.
		const name = dialog.getByLabel("Mailbox name");
		await expect(name).toHaveValue(`${token}-example`);
		await expect(dialog).toContainText("example.com");
		await name.fill(`${token}-own`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("status").filter({ hasText: `Connected ${address}.` })).toBeVisible();

		const created = (await mailboxesOf(user.api)).find((mailbox) => mailbox.localPart === `${token}-own`);
		expect(created).toBeDefined();
		const accounts = (await (await user.api.get("/api/external-accounts")).json()) as {
			accounts: { id: string; mailboxId: string }[];
		};
		expect(accounts.accounts[0].mailboxId).toBe(created!.id);
		await expect(page.locator(`[data-external-account="${address}"]`)).toContainText(
			`Mail goes to ${token}-own@example.com`,
		);

		// The import page starts in that mailbox, not in the one that was selected before.
		await page.getByRole("link", { name: "Import existing mail" }).click();
		await chooseOption(page.locator("#import-source"), { label: "IMAP" });
		await expectSelectValue(page.locator("#imap-account"), accounts.accounts[0].id);
		await expect(page.locator("#imap-account")).toBeVisible();
		await expect(page.getByTestId("import-target")).toContainText(`${token}-own@example.com`);
		await page.getByRole("button", { name: "Show folders" }).click();
		await page.getByRole("button", { name: "Import account" }).click();
		await waitForMessage(user.api, `${token} first`, { mailboxId: created!.id });

		// With an account connected, the mailbox is in use: the server refuses to remove it and says why.
		const refused = await user.api.delete(`/api/mailboxes/${created!.id}?onlyIfUnused=1`);
		expect(refused.status()).toBe(409);
		expect(((await refused.json()) as { code: string }).code).toBe("MAILBOX_IN_USE");

		// Edit still moves the account's future mail to another mailbox.
		await page.goto("/settings/connected-accounts");
		await page.locator(`[data-external-account="${address}"]`).getByRole("button", { name: "Edit" }).click();
		const edit = page.getByRole("dialog", { name: `Edit ${address}` });
		await expect(edit.getByRole("option", { name: "New mailbox for this account…" })).toHaveCount(0);
		const options = await readOptions(edit.locator("#external-mailbox"));
		expect(options.map((option) => option.label)).not.toContain("New mailbox for this account…");
		const other = options.find((option) => option.value !== created!.id);
		expect(other).toBeDefined();
		await chooseOption(edit.locator("#external-mailbox"), other!.value);
		await edit.getByRole("button", { name: "Save" }).click();
		await expect(edit).toBeHidden();
		const moved = (await (await user.api.get("/api/external-accounts")).json()) as {
			accounts: { mailboxId: string }[];
		};
		expect(moved.accounts[0].mailboxId).toBe(other!.value);
	} finally {
		await context.close();
		await fake.close();
	}
});

test("when connecting fails the new mailbox is named and can be reused or deleted", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("mf");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const { user, context, page } = await mailboxManager(browser, `mf${token.slice(-8)}`, true);
	try {
		let dialog = await openConnectDialog(page, address, fake.port, "wrong-password");
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		await dialog.getByLabel("Mailbox name").fill(`${token}-new`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog.getByRole("alert")).toContainText("Sign-in failed");
		const notice = dialog.getByTestId("mailbox-left-behind");
		await expect(notice).toContainText(`Kite created the mailbox ${token}-new@example.com`);
		await expect(notice).toContainText("not connected yet");
		expect((await mailboxesOf(user.api)).filter((mailbox) => mailbox.localPart === `${token}-new`)).toHaveLength(1);
		// The dialog now stands on the new mailbox, so another try reuses it.
		await expect(dialog.locator("#external-mailbox")).toContainText(`${token}-new@example.com`);

		// Reuse: the right password connects to the mailbox that was made, and no second one appears.
		await dialog.getByLabel("Password or app password").fill(APP_PASSWORD);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toBeHidden();
		const accounts = (await (await user.api.get("/api/external-accounts")).json()) as {
			accounts: { id: string; mailboxId: string }[];
		};
		const mailboxes = (await mailboxesOf(user.api)).filter((mailbox) => mailbox.localPart.startsWith(`${token}-`));
		expect(mailboxes).toHaveLength(1);
		expect(accounts.accounts[0].mailboxId).toBe(mailboxes[0].id);
		await page.locator(`[data-external-account="${address}"]`).getByRole("button", { name: "Remove" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

		// Delete: a failed connect, then the notice's Delete removes the mailbox and goes back to the old choice.
		dialog = await openConnectDialog(page, address, fake.port, "wrong-password");
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		await dialog.getByLabel("Mailbox name").fill(`${token}-gone`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog.getByTestId("mailbox-left-behind")).toContainText(`${token}-gone@example.com`);
		await dialog.getByRole("button", { name: `Delete ${token}-gone@example.com` }).click();
		await expect(dialog.getByTestId("mailbox-left-behind")).toHaveCount(0);
		expect((await mailboxesOf(user.api)).some((mailbox) => mailbox.localPart === `${token}-gone`)).toBe(false);

		// Closing the dialog with a mailbox left behind says so on the page.
		await dialog.getByLabel("Password or app password").fill("wrong-password");
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		await dialog.getByLabel("Mailbox name").fill(`${token}-left`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog.getByTestId("mailbox-left-behind")).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("status").filter({ hasText: `${token}-left@example.com` })).toContainText(
			"no account is connected to it",
		);
	} finally {
		await context.close();
		await fake.close();
	}
});

test("a taken name is refused before anything is created, and people who may not create mailboxes see nothing new", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const token = uniqueToken("mr");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const manager = await mailboxManager(browser, `mr${token.slice(-8)}`, true);
	const plain = await mailboxManager(browser, `mp${token.slice(-8)}`, false);
	try {
		const dialog = await openConnectDialog(manager.page, address, fake.port, APP_PASSWORD);
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		// The manager's own mailbox is taken: Kite says so and does not offer to connect.
		await dialog.getByLabel("Mailbox name").fill(`mr${token.slice(-8)}`);
		await expect(dialog.getByRole("alert").filter({ hasText: "already a mailbox" })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Connect" })).toBeDisabled();

		await openConnectDialog(plain.page, address, fake.port, APP_PASSWORD);
		const options = await readOptions(plain.page.getByRole("dialog").locator("#external-mailbox"));
		expect(options.map((option) => option.label).join(" ")).not.toContain("New mailbox");
		await expect(plain.page.getByRole("dialog").getByLabel("Mailbox name")).toHaveCount(0);
	} finally {
		await manager.context.close();
		await plain.context.close();
		await fake.close();
	}
});

test("after a failed connect another mailbox can be chosen, and the one Kite made is not used", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("ms");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const { user, context, page } = await mailboxManager(browser, `ms${token.slice(-8)}`, true);
	try {
		const dialog = await openConnectDialog(page, address, fake.port, "wrong-password");
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		await dialog.getByLabel("Mailbox name").fill(`${token}-spare`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog.getByTestId("mailbox-left-behind")).toContainText(`${token}-spare@example.com`);

		// A second "new mailbox" is not offered while the first is kept: it would be made and forgotten.
		const options = await readOptions(dialog.locator("#external-mailbox"));
		expect(options.map((option) => option.label)).not.toContain("New mailbox for this account…");
		const own = (await mailboxesOf(user.api)).find((mailbox) => mailbox.localPart === `ms${token.slice(-8)}`);
		expect(own).toBeDefined();
		await chooseOption(dialog.locator("#external-mailbox"), own!.id);
		await dialog.getByLabel("Password or app password").fill(APP_PASSWORD);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toBeHidden();

		// The account goes where the person chose, not to the mailbox Kite made; the page says that one is unused.
		const accounts = (await (await user.api.get("/api/external-accounts")).json()) as {
			accounts: { mailboxId: string }[];
		};
		expect(accounts.accounts[0].mailboxId).toBe(own!.id);
		await expect(page.getByRole("status").filter({ hasText: `Connected ${address}.` })).toContainText(
			`Kite had created the mailbox ${token}-spare@example.com`,
		);
		expect((await mailboxesOf(user.api)).some((mailbox) => mailbox.localPart === `${token}-spare`)).toBe(true);
	} finally {
		await context.close();
		await fake.close();
	}
});

test("Delete refuses a mailbox that has received mail since it was created", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("md");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const { user, context, page } = await mailboxManager(browser, `md${token.slice(-8)}`, true);
	try {
		const dialog = await openConnectDialog(page, address, fake.port, "wrong-password");
		await chooseOption(dialog.locator("#external-mailbox"), { label: "New mailbox for this account…" });
		await dialog.getByLabel("Mailbox name").fill(`${token}-busy`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		const notice = dialog.getByTestId("mailbox-left-behind");
		await expect(notice).toContainText(`${token}-busy@example.com`);

		// Mail arrives while the dialog is open.
		const created = (await mailboxesOf(user.api)).find((mailbox) => mailbox.localPart === `${token}-busy`);
		expect(created).toBeDefined();
		await turnScreenerOff(user.api, created!.id);
		await deliverInbound(user.api, {
			from: "someone@example.org",
			to: `${token}-busy@example.com`,
			subject: `${token} arrived`,
			text: "hello",
		});

		await dialog.getByRole("button", { name: `Delete ${token}-busy@example.com` }).click();
		await expect(dialog.getByRole("alert")).toContainText("mail has arrived in it");
		await expect(notice).toBeVisible();
		expect((await mailboxesOf(user.api)).some((mailbox) => mailbox.id === created!.id)).toBe(true);
		await waitForMessage(user.api, `${token} arrived`, { mailboxId: created!.id });
	} finally {
		await context.close();
		await fake.close();
	}
});

test("with no mailbox to choose from, a person who may create one starts on the new mailbox", async ({ browser }) => {
	test.setTimeout(120_000);
	const token = uniqueToken("mn");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } });
	const { context, page } = await mailboxManager(browser, `mn${token.slice(-8)}`, true);
	try {
		// The mailbox list is empty for this page, as for a new install before its first mailbox.
		await page.route(
			(url) => url.pathname === "/api/mailboxes",
			(route) =>
				route.request().method() === "GET"
					? route.fulfill({ json: { mailboxes: [], canCreateShared: false } })
					: route.continue(),
		);
		const dialog = await openConnectDialog(page, address, fake.port, APP_PASSWORD);
		await expect(dialog.locator("#external-mailbox")).toContainText("New mailbox for this account…");
		await expect(dialog.getByLabel("Mailbox name")).toHaveValue(`${token}-example`);
		await dialog.getByRole("button", { name: "Connect" }).click();
		await expect(dialog).toBeHidden();
	} finally {
		await context.close();
		await fake.close();
	}
});
