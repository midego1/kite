import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { contrastBetween } from "./support/contrast";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Connected accounts, PR 8 (docs/specs/external-accounts.md §6.1, §6.3, §18 decision 1): mail synced from an account
// carries a "via" chip in the list and the reader, `via:` and the reader's chip filter the list down to it, the
// forwarding guide renders on Settings → Connected accounts (and opens from the connect dialog for Microsoft), and
// "Also sync the Spam folder" brings the provider's Spam folder into Kite's Spam, from the moment it is turned on.

const APP_PASSWORD = "fake-app-password";

type ListedMessage = { subject: string | null; status: string; via?: { address: string; preset: string } };

async function search(api: APIRequestContext, query: string): Promise<ListedMessage[]> {
	const response = await api.get(`/api/messages?${new URLSearchParams({ q: query, limit: "50" })}`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { messages: ListedMessage[] }).messages;
}

async function connect(api: APIRequestContext, address: string, mailboxId: string, port: number) {
	const response = await api.post("/api/external-accounts", {
		data: {
			address,
			preset: "other",
			mailboxId,
			imap: { host: "127.0.0.1", port, security: "starttls" },
			password: APP_PASSWORD,
			kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
		},
	});
	expect(response.status(), await response.text()).toBe(201);
	return ((await response.json()) as { account: { id: string } }).account;
}

/** Check now, retried while the one-a-minute window of the previous check is still open. */
async function checkNow(api: APIRequestContext, accountId: string) {
	await expect
		.poll(async () => (await api.post(`/api/external-accounts/${accountId}/sync`)).status(), {
			timeout: 90_000,
			intervals: [5_000],
		})
		.toBe(202);
}

async function setStyle(page: Page, style: string, theme: string) {
	await page.addInitScript(
		({ style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		},
		{ style, theme },
	);
}

test("synced mail shows a via chip in the list and the reader, and via: filters to it", async ({
	browser,
}, testInfo) => {
	test.setTimeout(180_000);
	const token = uniqueToken("xvia");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD }, folders: { INBOX: [] } });
	const admin = await apiContext(STORAGE_STATE);
	const username = `vi${token.slice(-8)}`;
	const user = await createSignedInAccount(admin, username);
	try {
		const account = await connect(user.api, address, user.mailboxId, fake.port);
		fake.addMessage("INBOX", sampleMessage(1, { subject: `${token} synced` }));
		await checkNow(user.api, account.id);
		await waitForMessage(user.api, `${token} synced`);
		// Mail Kite receives itself has no chip and is left out by via:.
		await postInbound(user.api, {
			from: "Someone <someone@example.org>",
			to: `${username}@${DOMAIN}`,
			subject: `${token} received`,
			text: "Delivered to Kite directly.",
		});
		await waitForMessage(user.api, `${token} received`);

		const all = await search(user.api, token);
		expect(all.find((message) => message.subject === `${token} synced`)?.via).toMatchObject({
			address,
			preset: "other",
		});
		expect(all.find((message) => message.subject === `${token} received`)?.via).toBeUndefined();
		for (const query of [`via:${address}`, "via:example.test", "via:imap", `via:"${address.toUpperCase()}"`])
			expect(
				(await search(user.api, `${token} ${query}`)).map((message) => message.subject),
				query,
			).toEqual([`${token} synced`]);
		expect(await search(user.api, `${token} via:gmail`)).toEqual([]);

		for (const variant of [
			{ name: "kite-dark", style: "kite", theme: "dark" },
			{ name: "kite-light", style: "kite", theme: "light" },
			{ name: "lavender-light", style: "lavender", theme: "light" },
			{ name: "classic-dark", style: "classic", theme: "dark" },
		]) {
			const context = await browser.newContext({ storageState: await user.api.storageState() });
			try {
				const page = await context.newPage();
				await setStyle(page, variant.style, variant.theme);
				await page.goto("/inbox");
				await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
				const row = page.locator("[data-message-row]").filter({ hasText: `${token} synced` });
				const chip = row.locator(`[data-via-account="${address}"]`);
				await expect(chip).toHaveText("via example.test", { timeout: 60_000 });
				await expect(chip).toHaveAttribute("title", `Arrived through ${address}`);
				expect(await contrastBetween(chip), variant.name).toBeGreaterThan(4.5);
				await expect(
					page
						.locator("[data-message-row]")
						.filter({ hasText: `${token} received` })
						.locator("[data-via-account]"),
				).toHaveCount(0);
				await page.screenshot({ path: testInfo.outputPath(`via-chip-${variant.name}.png`) });
			} finally {
				await context.close();
			}
		}

		// The reader's chip filters the list to everything that came through the account.
		const context = await browser.newContext({ storageState: await user.api.storageState() });
		try {
			const page = await context.newPage();
			await page.goto("/inbox");
			await page
				.locator("[data-message-row]")
				.filter({ hasText: `${token} synced` })
				.getByRole("link")
				.first()
				.click();
			const readerChip = page.getByRole("button", { name: `via example.test: show all mail through ${address}` });
			await expect(readerChip).toBeVisible({ timeout: 30_000 });
			await readerChip.click();
			await expect(page.getByRole("textbox", { name: /Search mail/ }).first()).toHaveValue(`via:${address}`);
			await expect(page.locator("[data-message-row]").filter({ hasText: `${token} synced` })).toBeVisible();
			await expect(page.locator("[data-message-row]").filter({ hasText: `${token} received` })).toHaveCount(0);
		} finally {
			await context.close();
		}

		// A removed account's mail stays, without a chip.
		expect((await user.api.delete(`/api/external-accounts/${account.id}`)).ok()).toBe(true);
		expect((await search(user.api, `${token} synced`))[0]?.via).toBeUndefined();
	} finally {
		await fake.close();
	}
});

test("the forwarding guide renders with the Kite address and opens from the connect dialog for Microsoft", async ({
	browser,
}) => {
	const token = uniqueToken("xfwd");
	const admin = await apiContext(STORAGE_STATE);
	const username = `fw${token.slice(-8)}`;
	const user = await createSignedInAccount(admin, username);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	try {
		const page = await context.newPage();
		await page.goto("/settings/connected-accounts");
		const guide = page.locator("[data-forwarding-guide]");
		await expect(guide.getByRole("heading", { name: "Or forward mail to Kite" })).toBeVisible();
		await expect(guide.locator("[data-forwarding-address]")).toHaveText(`${username}@${DOMAIN}`);
		// Gmail first, with its settings page and the address filled into the steps.
		await expect(guide.locator("[data-forwarding-provider]")).toHaveAttribute("data-forwarding-provider", "gmail");
		await expect(guide.getByRole("link", { name: /Open Gmail's forwarding settings/ })).toHaveAttribute(
			"href",
			"https://mail.google.com/mail/u/0/#settings/fwdandpop",
		);
		await expect(
			guide
				.getByRole("listitem")
				.filter({ hasText: `${username}@${DOMAIN}` })
				.first(),
		).toBeVisible();
		for (const name of ["iCloud Mail", "Yahoo Mail", "Fastmail", "Other providers"]) {
			await guide.getByRole("button", { name }).click();
			await expect(guide.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
		}
		await expect(guide.getByText("Do not also connect the same account", { exact: false })).toBeVisible();

		// Microsoft cannot be connected: the dialog offers forwarding, which opens the guide at Outlook.
		await page.getByRole("button", { name: "Connect account" }).click();
		const dialog = page.getByRole("dialog");
		await chooseOption(dialog.getByLabel("Provider"), "microsoft");
		await dialog.getByRole("button", { name: "Set up forwarding" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(guide.locator("[data-forwarding-provider]")).toHaveAttribute("data-forwarding-provider", "microsoft");
		await expect(guide.getByRole("link", { name: /Open Outlook.com forwarding/ })).toHaveAttribute(
			"href",
			"https://outlook.live.com/mail/0/options/mail/forwarding",
		);
		await expect(guide.getByText("does not allow external forwarding", { exact: false })).toBeVisible();
	} finally {
		await context.close();
	}
});

test("Also sync the Spam folder brings new Spam-folder mail into Kite's Spam, only while it is on", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const token = uniqueToken("xjnk");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({
		authPlain: true,
		specialUse: true,
		folderAttributes: { Junk: ["\\Junk"] },
		users: { [address]: APP_PASSWORD },
		folders: { INBOX: [], Junk: [sampleMessage(1, { subject: `${token} spam from before` })] },
	});
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `jn${token.slice(-8)}`);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	try {
		const account = await connect(user.api, address, user.mailboxId, fake.port);
		const page = await context.newPage();
		await page.goto("/settings/connected-accounts");
		const toggle = page.getByRole("switch", { name: `Also sync the Spam folder of ${address}` });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(page.locator(`[data-account-spam-sync="${address}"]`)).toContainText("arrives in Kite's Spam");

		// The first check takes the Spam folder's place; what was there before stays out.
		await checkNow(user.api, account.id);
		await expect
			.poll(() => fake.commands.some((command) => /EXAMINE "Junk"/.test(command.line)), { timeout: 45_000 })
			.toBe(true);
		fake.addMessage("Junk", sampleMessage(2, { subject: `${token} false positive` }));
		fake.addMessage("INBOX", sampleMessage(3, { subject: `${token} inbox` }));
		await checkNow(user.api, account.id);
		const spam = await waitForMessage(user.api, `${token} false positive`, { status: "spam" });
		expect(spam.status).toBe("spam");
		await waitForMessage(user.api, `${token} inbox`, { status: "received" });
		expect((await search(user.api, token)).map((message) => message.subject).sort()).toEqual([
			`${token} false positive`,
			`${token} inbox`,
		]);
		// Kite only reads: nothing is stored, moved or deleted at the source, Spam folder included.
		expect(fake.commands.some((command) => /\b(STORE|COPY|MOVE|EXPUNGE|APPEND|SELECT)\b/i.test(command.line))).toBe(
			false,
		);
	} finally {
		await context.close();
		await fake.close();
	}
});
