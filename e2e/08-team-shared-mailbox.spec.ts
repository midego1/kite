import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, openMessage, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "teammate-password-123";

async function createAccountInUi(page: Page, username: string) {
	await page.goto("/accounts");
	await page.getByRole("button", { name: "New account" }).click();
	const dialog = page.getByRole("dialog", { name: "Add user account" });
	await dialog.getByLabel("Email").fill(username);
	await expect(dialog.getByRole("combobox", { name: "Domain" })).toHaveValue(/.+/);
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Create account" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("link", { name: new RegExp(`${username}@${DOMAIN}`) })).toBeVisible();
}

async function signInFresh(browser: Browser, email: string) {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	return { context, page };
}

async function accessibleMailboxAddresses(api: APIRequestContext): Promise<string[]> {
	const response = await api.get("/api/mailboxes");
	expect(response.ok()).toBe(true);
	const data = (await response.json()) as { mailboxes: { localPart: string; hostname: string }[] };
	return data.mailboxes.map((mailbox) => `${mailbox.localPart}@${mailbox.hostname}`);
}

test("an admin shares a team mailbox with one account and not another", async ({ page, browser }) => {
	const token = uniqueToken("t");
	const teammate = `mate${token}`;
	const outsider = `out${token}`;
	const sharedLocalPart = `team${token}`;
	const sharedAddress = `${sharedLocalPart}@${DOMAIN}`;
	const sharedName = `Team ${token}`;
	const subject = `Shared hello ${token}`;

	await test.step("admin creates two accounts", async () => {
		await createAccountInUi(page, teammate);
		await createAccountInUi(page, outsider);
	});

	await test.step("admin creates a shared mailbox", async () => {
		await page.goto("/mailboxes");
		await page.getByRole("button", { name: "New mailbox" }).click();
		const dialog = page.getByRole("dialog", { name: "Create mailbox" });
		await dialog.getByLabel("Type").selectOption({ label: "Shared inbox" });
		await dialog.getByLabel("Name").fill(sharedName);
		await dialog.getByLabel("Email address").fill(sharedLocalPart);
		await dialog.getByRole("combobox", { name: "Domain" }).selectOption({ label: DOMAIN });
		await dialog.getByRole("button", { name: "Create mailbox" }).click();
		await expect(page).toHaveURL(/\/mailboxes\/mbx_/);
		await expect(page.getByText("Shared access")).toBeVisible();
		await expect(page.getByText("No one else has access yet.")).toBeVisible();
	});

	const admin = await apiContext(STORAGE_STATE);
	await test.step("mail arrives in the shared mailbox", async () => {
		await deliverInbound(admin, {
			from: `"Customer" <customer@outside.test>`,
			to: sharedAddress,
			subject,
			text: `Hello team ${token}`,
		});
	});
	const [stored] = (
		(await (await admin.get(`/api/messages?q=${encodeURIComponent(subject)}`)).json()) as { messages: { id: string }[] }
	).messages;
	expect(stored).toBeDefined();

	await test.step("before being granted access the teammate cannot see it", async () => {
		const api = await apiSignIn(`${teammate}@${DOMAIN}`, PASSWORD);
		expect(await accessibleMailboxAddresses(api)).not.toContain(sharedAddress);
		expect([403, 404]).toContain((await api.get(`/api/messages/${stored.id}`)).status());
		await api.dispose();
	});

	await test.step("admin grants the teammate access", async () => {
		await page
			.getByRole("combobox", { name: "Account to add" })
			.selectOption({ label: `${teammate} (${teammate}@${DOMAIN})` });
		await page.getByRole("button", { name: "Add user" }).click();
		await expect(page.getByRole("button", { name: `Remove ${teammate}` })).toBeVisible();
		await expect(page.getByText("No one else has access yet.")).toBeHidden();
	});

	await test.step("the teammate sees the shared mailbox and reads its mail", async () => {
		const { context, page: matePage } = await signInFresh(browser, `${teammate}@${DOMAIN}`);
		await matePage.getByRole("button", { name: "Open account menu" }).click();
		await matePage.getByRole("button", { name: /^Inboxes \(\d+\)/ }).click();
		await matePage.getByRole("button", { name: new RegExp(sharedName) }).click();
		await expect(matePage).toHaveURL(/\/inbox$/);
		await openMessage(matePage, subject);
		await expect(matePage.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		await expect(matePage.getByRole("article").getByText(`Hello team ${token}`)).toBeVisible();
		await context.close();
	});

	await test.step("an account without access still cannot see it", async () => {
		const api = await apiSignIn(`${outsider}@${DOMAIN}`, PASSWORD);
		expect(await accessibleMailboxAddresses(api)).not.toContain(sharedAddress);
		expect([403, 404]).toContain((await api.get(`/api/messages/${stored.id}`)).status());
		const search = (await (await api.get(`/api/messages?q=${encodeURIComponent(subject)}`)).json()) as {
			messages: unknown[];
		};
		expect(search.messages).toHaveLength(0);
		await api.dispose();
	});
	await admin.dispose();
});
