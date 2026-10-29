import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, openMessage, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption, readOptions } from "./support/select";
import { markKnownProvider } from "./support/send-as";
import { startFakeImap } from "../tests/support/fake-imap.mjs";
import { startFakeSmtp } from "../tests/support/fake-smtp.mjs";

// Send-as (docs/specs/external-accounts.md §7, PR 10): a connected account's address in the composer's From menu,
// the message going out through the account's own SMTP server (the fake on 127.0.0.1, plain text only there under
// EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK), the Sent copy in Kite and at the provider (IMAP APPEND), a reply from
// the address the mail came to, an alias that is never offered, and a refused sign-in that asks to reconnect.

const APP_PASSWORD = "fake-app-password";
const RECIPIENT = "friend@e2e.test";

type Fakes = { smtp: Awaited<ReturnType<typeof startFakeSmtp>>; imap: Awaited<ReturnType<typeof startFakeImap>> };

async function startFakes(address: string, smtpOptions: Record<string, unknown> = {}): Promise<Fakes> {
	const smtp = await startFakeSmtp({ users: { [address]: APP_PASSWORD }, ...smtpOptions });
	const imap = await startFakeImap({
		authPlain: true,
		specialUse: true,
		users: { [address]: APP_PASSWORD },
		folders: { INBOX: [], Sent: [] },
		folderAttributes: { Sent: ["\\Sent"] },
	});
	return { smtp, imap };
}

async function connectSendAs(
	api: APIRequestContext,
	mailboxId: string,
	address: string,
	fakes: Fakes,
	extra: Record<string, unknown> = {},
) {
	const response = await api.post("/api/external-accounts", {
		data: {
			address,
			label: address,
			displayName: "Pat Example",
			preset: "other",
			mailboxId,
			imap: { host: "127.0.0.1", port: fakes.imap.port, security: "starttls" },
			smtp: { host: "127.0.0.1", port: fakes.smtp.port, security: "starttls" },
			password: APP_PASSWORD,
			kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
			...extra,
		},
	});
	expect(response.status(), await response.text()).toBe(201);
	const { account } = (await response.json()) as {
		account: { id: string; sending: { verified: boolean; block: string | null } };
	};
	// Connected as "Other" (the only way to reach the fakes), the address is unproven until it is a known provider's.
	if (!extra.username) markKnownProvider(address);
	return account;
}

async function userPage(browser: Browser, api: APIRequestContext) {
	const context = await browser.newContext({ storageState: await api.storageState() });
	return { context, page: await context.newPage() };
}

test("the From menu offers the connected address; mail goes out through its SMTP server and is saved in Sent at both ends", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const token = uniqueToken("sendas");
	const address = `${token}@example.test`;
	const fakes = await startFakes(address);
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sa${token.slice(-8)}`);
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const { context, page } = await userPage(browser, user.api);
	try {
		const account = await connectSendAs(user.api, user.mailboxId, address, fakes);
		// As "Other" the address was not offered: the server the user entered proves nothing about it.
		expect(account.sending).toMatchObject({ verified: true, block: "unproven" });
		expect(fakes.smtp.messages).toHaveLength(0);

		await page.goto("/settings/connected-accounts");
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row).toContainText(`You can send as ${address} from the composer's From menu.`);
		await expect(row.getByRole("switch", { name: `Send from ${address}` })).toBeChecked();
		await expect(row.getByRole("switch", { name: `Save a copy in the Sent folder of ${address}` })).toBeChecked();

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const from = page.getByRole("combobox", { name: "From" });
		const options = await readOptions(from);
		expect(options.map((option) => option.label)).toContain(`${address} (via Fastmail)`);
		await chooseOption(from, { label: `${address} (via Fastmail)` });
		const to = page.getByLabel("To", { exact: true });
		await to.fill(RECIPIENT);
		await to.press("Enter");
		await page.getByRole("button", { name: "Bcc" }).click();
		const bcc = page.getByLabel("Bcc", { exact: true });
		await bcc.fill("hidden@e2e.test");
		await bcc.press("Enter");
		const subject = `Send-as ${token}`;
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("textbox", { name: "Message body" }).fill("Hello from the connected account.");
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(page.getByText("Message sent")).toBeVisible();

		expect(fakes.smtp.messages).toHaveLength(1);
		const [delivered] = fakes.smtp.messages;
		expect(delivered.from).toBe(address);
		expect(delivered.recipients).toEqual([RECIPIENT, "hidden@e2e.test"]);
		const raw = delivered.raw.toString("latin1");
		expect(raw).toMatch(new RegExp(`^From: Pat Example <${address}>\\r$`, "m"));
		expect(raw).toMatch(new RegExp(`^Subject: ${subject}\\r$`, "m"));
		expect(raw).toMatch(/^Message-ID: <kite\.msg_[^@]+@example\.test>\r$/m);
		expect(raw).not.toContain("hidden@e2e.test");

		const stored = await waitForMessage(user.api, subject, { status: "sent" });
		await page.goto("/sent");
		await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
		// The Sent copy at the provider: the exact bytes, marked read, in the folder marked \Sent.
		await expect.poll(() => fakes.imap.appends.length, { timeout: 30_000 }).toBe(1);
		expect(fakes.imap.appends[0]).toMatchObject({ folder: "Sent", flags: ["\\Seen"] });
		expect(fakes.imap.appends[0].raw).toBe(raw);
		// The message source in Kite is those bytes too.
		const source = await user.api.get(`/api/messages/${stored.id}/original`);
		expect(source.ok()).toBe(true);
		expect(await source.text()).toBe(raw);
	} finally {
		await context.close();
		await Promise.all([fakes.smtp.close(), fakes.imap.close()]);
	}
});

test("a reply goes out from the address the mail came to; an alias is never offered", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("sareply");
	const address = `${token}@example.test`;
	const alias = `alias-${token}@example.test`;
	const fakes = await startFakes(address);
	const aliasImap = await startFakeImap({ authPlain: true, users: { "login-name": APP_PASSWORD } });
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sr${token.slice(-8)}`);
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const { context, page } = await userPage(browser, user.api);
	try {
		await connectSendAs(user.api, user.mailboxId, address, fakes);
		// An account whose user name is not its address: its address needs a verification code first (PR 11).
		const aliasAccount = await connectSendAs(
			user.api,
			user.mailboxId,
			alias,
			{ ...fakes, imap: aliasImap },
			{
				username: "login-name",
			},
		);
		expect(aliasAccount.sending.block).toBe("alias");

		// Mail that came to the connected address (forwarded from it into Kite).
		const subject = `Question ${token}`;
		const kiteAddress = `sr${token.slice(-8)}@example.com`;
		const messageId = `<${randomUUID()}@sender.e2e.test>`;
		const mime = [
			"From: Sam Sender <sam@sender.e2e.test>",
			`To: ${address}`,
			`Subject: ${subject}`,
			`Message-ID: ${messageId}`,
			`Date: ${new Date().toUTCString()}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Can you send me the notes?",
			"",
		].join("\r\n");
		const query = new URLSearchParams({ from: "sam@sender.e2e.test", to: kiteAddress });
		const delivered = await user.api.post(`/cdn-cgi/handler/email?${query}`, {
			data: mime,
			headers: { "Content-Type": "message/rfc822" },
		});
		expect(delivered.status()).toBe(200);
		await waitForMessage(user.api, subject);

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const labels = (await readOptions(page.getByRole("combobox", { name: "From" }))).map((option) => option.label);
		expect(labels.some((label) => label.startsWith(address))).toBe(true);
		expect(labels.some((label) => label.includes(alias))).toBe(false);
		await page.keyboard.press("Escape");

		await page.goto("/inbox");
		await openMessage(page, subject);
		// "Reply (r)" while keyboard shortcuts are on.
		await page
			.getByRole("button", { name: /^Reply( \(r\))?$/ })
			.first()
			.click();
		await page.getByRole("textbox", { name: "Message body" }).fill("Here are the notes.");
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect.poll(() => fakes.smtp.messages.length).toBe(1);
		const raw = fakes.smtp.messages[0].raw.toString("latin1");
		expect(fakes.smtp.messages[0].from).toBe(address);
		expect(raw).toMatch(new RegExp(`^From: Pat Example <${address}>\\r$`, "m"));
		expect(raw).toContain(`In-Reply-To: ${messageId}`);
		expect(fakes.smtp.messages[0].recipients).toEqual(["sam@sender.e2e.test"]);
	} finally {
		await context.close();
		await Promise.all([fakes.smtp.close(), fakes.imap.close(), aliasImap.close()]);
	}
});

test("a refused SMTP sign-in fails the send and asks to reconnect the account", async ({ browser }) => {
	test.setTimeout(150_000);
	const token = uniqueToken("sa535");
	const address = `${token}@example.test`;
	const fakes = await startFakes(address);
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sf${token.slice(-8)}`);
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const { context, page } = await userPage(browser, user.api);
	try {
		await connectSendAs(user.api, user.mailboxId, address, fakes);
		fakes.smtp.failNext("auth", 535, "5.7.8 Username and Password not accepted");

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		await chooseOption(page.getByRole("combobox", { name: "From" }), {
			label: `${address} (via Fastmail)`,
		});
		const to = page.getByLabel("To", { exact: true });
		await to.fill(RECIPIENT);
		await to.press("Enter");
		await page.getByLabel("Subject").fill(`Refused ${token}`);
		await page.getByRole("textbox", { name: "Message body" }).fill("This one is refused.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByText(/SMTP sign-in failed: 535/)).toBeVisible();
		expect(fakes.smtp.messages).toHaveLength(0);

		await page.goto("/settings/connected-accounts");
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row).toContainText("Sign-in failed");
		await expect(row).toContainText("Reconnect the account to send from this address.");
		await expect(row).not.toContainText(APP_PASSWORD);

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const from = page.getByRole("combobox", { name: "From" });
		await from.click();
		const option = page.getByRole("listbox").getByRole("option", { name: `${address} (Reconnect in Settings)` });
		await expect(option).toHaveAttribute("data-disabled", "");
		await page.keyboard.press("Escape");
	} finally {
		await context.close();
		await Promise.all([fakes.smtp.close(), fakes.imap.close()]);
	}
});
