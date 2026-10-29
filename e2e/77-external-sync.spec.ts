import { expect, test, type APIRequestContext } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { cronTick } from "./support/finance";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Connected accounts, sync (docs/specs/external-accounts.md §6, PR 7): an account at the fake IMAP server on
// 127.0.0.1 is checked by **Check now** and by the 5-minute cron; new INBOX mail arrives once in the account's
// mailbox (read state kept, a repeated Message-ID dropped, mail from before connecting left out), Pause stops
// checking, and removing the account keeps the mail.

const APP_PASSWORD = "fake-app-password";

type SyncView = { lastSuccessAt: string | null; enabled: boolean; running: boolean };
type AccountView = { id: string; address: string; status: string; sync: SyncView };

async function readAccount(api: APIRequestContext): Promise<AccountView> {
	const response = await api.get("/api/external-accounts");
	expect(response.ok()).toBe(true);
	const { accounts } = (await response.json()) as { accounts: AccountView[] };
	return accounts[0];
}

async function messageList(api: APIRequestContext, query: string) {
	const response = await api.get(`/api/messages?${new URLSearchParams({ q: query, limit: "50" })}`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { messages: { subject: string | null; read?: boolean }[] }).messages;
}

test("new INBOX mail arrives once through Check now and the cron, keeps its read state, and stays after removing", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const token = uniqueToken("xsync");
	const address = `${token}@example.test`;
	const fake = await startFakeImap({
		authPlain: true,
		users: { [address]: APP_PASSWORD },
		folders: { INBOX: [sampleMessage(1, { subject: `${token} before connecting` })] },
	});
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `sy${token.slice(-8)}`);
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

		const messageId = `<${token}-dup@example.org>`;
		fake.addMessage("INBOX", { raw: sampleMessage(2, { subject: `${token} read at the phone` }), flags: ["\\Seen"] });
		fake.addMessage("INBOX", sampleMessage(3, { subject: `${token} unread`, messageId }));
		fake.addMessage("INBOX", sampleMessage(4, { subject: `${token} same message again`, messageId }));

		await page.goto("/settings/connected-accounts");
		const row = page.locator(`[data-external-account="${address}"]`);
		await expect(row.locator("[data-sync-status]")).toHaveText("Kite checks for new mail within five minutes.", {
			timeout: 60_000,
		});
		await row.getByRole("button", { name: "Check now" }).click();
		await expect(row.getByRole("status")).toHaveText("Checking for new mail…");
		await waitForMessage(user.api, `${token} read at the phone`);
		await waitForMessage(user.api, `${token} unread`);
		// A second Check now within a minute is refused.
		expect((await user.api.post(`/api/external-accounts/${(await readAccount(user.api)).id}/sync`)).status()).toBe(429);

		const messages = await messageList(user.api, token);
		expect(messages.map((message) => message.subject).sort()).toEqual([
			`${token} read at the phone`,
			`${token} unread`,
		]);
		expect(messages.find((message) => message.subject?.endsWith("read at the phone"))?.read).toBe(true);
		expect(messages.find((message) => message.subject?.endsWith("unread"))?.read).toBe(false);
		expect(fake.commands.filter((command) => /EXAMINE "INBOX"/.test(command.line)).length).toBe(2);
		// Kite only reads: no command stores, moves, deletes or marks anything at the source.
		expect(fake.commands.some((command) => /\b(STORE|COPY|MOVE|EXPUNGE|APPEND|SELECT)\b/i.test(command.line))).toBe(
			false,
		);
		await page.reload();
		await expect(row.locator("[data-sync-status]")).toContainText(/Checked (just now|1 minute ago)/);

		// Pause: no Check now, and the cron leaves the account alone.
		await row.getByRole("button", { name: "Pause" }).click();
		await expect(row.locator("[data-sync-status]")).toHaveText("Checking for new mail is paused.");
		await expect(row.getByRole("button", { name: "Check now" })).toHaveCount(0);
		const before = fake.commands.length;
		fake.addMessage("INBOX", sampleMessage(5, { subject: `${token} while paused` }));
		await cronTick(admin);
		await page.waitForTimeout(2_000);
		expect(fake.commands.length).toBe(before);
		await row.getByRole("button", { name: "Resume" }).click();
		await expect(row.getByRole("button", { name: "Pause" })).toBeVisible();

		// The cron picks the resumed account up at once.
		await cronTick(admin);
		await waitForMessage(user.api, `${token} while paused`);

		await row.getByRole("button", { name: "Remove" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
		await expect(row).toHaveCount(0);
		const kept = await messageList(user.api, token);
		expect(kept).toHaveLength(3);
		expect(kept.some((message) => message.subject?.endsWith("before connecting"))).toBe(false);
	} finally {
		await context.close();
		await fake.close();
	}
});
