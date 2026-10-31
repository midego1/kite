import { expect, test, type APIRequestContext } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken } from "./support/helpers";
import { chooseOption, readOptions } from "./support/select";
import { readMailedCode } from "./support/send-as";
import { startFakeImap } from "../tests/support/fake-imap.mjs";
import { startFakeSmtp } from "../tests/support/fake-smtp.mjs";

// Send-as verification codes (docs/specs/external-accounts.md §7.2, PR 11): an "Other" provider's address is offered
// as From only after the code Kite mails to it is entered in Settings → Connected accounts; a wrong code says how many
// tries are left; an alias of the account is added, verified and sent from through the account's own SMTP server;
// and a removed alias leaves the From menu. The code is read back from its stored HMAC (e2e/support/send-as.ts).

const APP_PASSWORD = "fake-app-password";
const RECIPIENT = "friend@e2e.test";

async function sendFrom(page: import("@playwright/test").Page, label: string, subject: string) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	await chooseOption(page.getByRole("combobox", { name: "From" }), { label });
	const to = page.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await page.getByLabel("Subject").fill(subject);
	await page.getByRole("textbox", { name: "Message body" }).fill("Sent from a verified address.");
	const sent = page.waitForResponse(
		(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	expect((await sent).ok()).toBe(true);
}

async function fromLabels(page: import("@playwright/test").Page): Promise<string[]> {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	const labels = (await readOptions(page.getByRole("combobox", { name: "From" }))).map((option) => option.label);
	await page.keyboard.press("Escape");
	return labels;
}

async function connectOther(
	api: APIRequestContext,
	mailboxId: string,
	address: string,
	ports: { imap: number; smtp: number },
) {
	const response = await api.post("/api/external-accounts", {
		data: {
			address,
			label: address,
			preset: "other",
			mailboxId,
			imap: { host: "127.0.0.1", port: ports.imap, security: "starttls" },
			smtp: { host: "127.0.0.1", port: ports.smtp, security: "starttls" },
			password: APP_PASSWORD,
			kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
		},
	});
	expect(response.status(), await response.text()).toBe(201);
	return ((await response.json()) as { account: { id: string; sending: { block: string | null } } }).account;
}

test("an Other provider's address and an alias are sent as only after their mailed codes", async ({ browser }) => {
	test.setTimeout(240_000);
	const token = uniqueToken("verify");
	const address = `${token}@example.test`;
	const alias = `alias-${token}@example.test`;
	const smtp = await startFakeSmtp({ users: { [address]: APP_PASSWORD } });
	const imap = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD }, folders: { INBOX: [] } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `vf${token.slice(-8)}`);
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	const page = await context.newPage();
	try {
		const account = await connectOther(user.api, user.mailboxId, address, { imap: imap.port, smtp: smtp.port });
		expect(account.sending.block).toBe("unproven");
		expect(await fromLabels(page)).toContain(`${address} (Verify in Settings)`);

		// The account's own address: Verify, a wrong code, then the right one.
		await page.goto("/settings/connected-accounts");
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row).toContainText("it needs a code mailed to this address");
		await row.getByRole("button", { name: `Verify ${address}` }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByLabel("Email address")).toHaveValue(address);
		await dialog.getByRole("button", { name: "Send code" }).click();
		await expect(dialog).toContainText(`Kite sent a code to ${address}.`);
		const code = readMailedCode(account.id, address);
		await dialog.getByLabel("Verification code").fill(code === "000000" ? "111111" : "000000");
		await dialog.getByRole("button", { name: "Verify" }).click();
		await expect(dialog.getByRole("alert")).toHaveText("That code is not right. 4 attempts left.");
		await dialog.getByLabel("Verification code").fill(code);
		await dialog.getByRole("button", { name: "Verify" }).click();
		await expect(dialog).toBeHidden();
		await expect(row).toContainText(`You can now send as ${address}.`);
		await expect(row).toContainText(`You can send as ${address} from the composer's From menu.`);

		await sendFrom(page, `${address} (via Other IMAP provider)`, `Verified ${token}`);
		await expect.poll(() => smtp.messages.length).toBe(1);
		expect(smtp.messages[0].from).toBe(address);

		// An alias: added, verified, sent from through the account's SMTP server.
		await page.goto("/settings/connected-accounts");
		await row.getByRole("button", { name: "Send from another address" }).click();
		await dialog.getByLabel("Email address").fill(alias);
		await dialog.getByRole("button", { name: "Send code" }).click();
		await expect(dialog).toContainText(`Kite sent a code to ${alias}.`);
		await dialog.getByLabel("Verification code").fill(readMailedCode(account.id, alias));
		await dialog.getByRole("button", { name: "Verify" }).click();
		await expect(dialog).toBeHidden();
		const aliasRow = row.locator(`[data-identity="${alias}"]`);
		await expect(aliasRow).toContainText("Verified");

		await sendFrom(page, `${alias} (via Other IMAP provider)`, `Alias ${token}`);
		await expect.poll(() => smtp.messages.length).toBe(2);
		expect(smtp.messages[1].from).toBe(alias);
		const raw = smtp.messages[1].raw.toString("latin1");
		expect(raw).toMatch(new RegExp(`^From: .*<${alias}>\\r$`, "m"));

		// Removed: no longer offered.
		await page.goto("/settings/connected-accounts");
		await row.locator(`[data-identity="${alias}"]`).getByRole("button", { name: "Remove" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
		await expect(row.locator(`[data-identity="${alias}"]`)).toHaveCount(0);
		const labels = await fromLabels(page);
		expect(labels.some((label) => label.includes(alias))).toBe(false);
		expect(labels).toContain(`${address} (via Other IMAP provider)`);
	} finally {
		await context.close();
		await Promise.all([smtp.close(), imap.close()]);
	}
});
