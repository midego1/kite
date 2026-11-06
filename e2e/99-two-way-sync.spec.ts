import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { cronTick } from "./support/finance";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Two-way sync of connected accounts (docs/specs/external-accounts.md §6.8), against the fake IMAP server: the settings
// in the account row, each one both ways through the real check, nothing with the settings off, a trash move that is a
// MOVE and never an expunge, a provider that rebuilt its Inbox, and a failure in the account's problems.

const APP_PASSWORD = "fake-app-password";
const SERVER = {
	authPlain: true,
	specialUse: true,
	move: true,
	uidplus: true,
	folderAttributes: { Trash: ["\\Trash"], Junk: ["\\Junk"], Archive: ["\\Archive"] },
};
const OFF = {
	kiteDelete: "nothing",
	kiteArchive: "nothing",
	kiteSpam: "nothing",
	kiteFlags: false,
	providerGone: "nothing",
	providerFlags: false,
};
const WRITES = /\b(STORE|COPY|MOVE|EXPUNGE)\b|^\S+ SELECT /i;

type Fake = Awaited<ReturnType<typeof startFakeImap>>;
type Account = { id: string; sync: { lastSuccessAt: string | null } };
type ListedMessage = { id: string; subject: string | null; status: string; read: boolean; starred: boolean };

async function readAccount(api: APIRequestContext): Promise<Account> {
	const response = await api.get("/api/external-accounts");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { accounts: Account[] }).accounts[0];
}

/** One regular check through the cron: pausing and resuming makes the account due at once, past Check now's limit. */
async function runCheck(api: APIRequestContext, admin: APIRequestContext, id: string) {
	const before = (await readAccount(api)).sync.lastSuccessAt;
	// The stored time counts in seconds, so a check right after another must land in a later one.
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	expect((await api.patch(`/api/external-accounts/${id}`, { data: { syncEnabled: false } })).ok()).toBe(true);
	expect((await api.patch(`/api/external-accounts/${id}`, { data: { syncEnabled: true } })).ok()).toBe(true);
	await expect
		.poll(
			async () => {
				await cronTick(admin);
				return (await readAccount(api)).sync.lastSuccessAt;
			},
			{ timeout: 45_000, intervals: [1_000] },
		)
		.not.toBe(before);
}

async function setup(token: string, options = {}) {
	const address = `${token}@example.test`;
	const fake = await startFakeImap({
		...SERVER,
		users: { [address]: APP_PASSWORD },
		folders: { INBOX: [], Trash: [], Junk: [], Archive: [] },
		...options,
	});
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `tw${token.slice(-8)}`);
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
	const { id } = await readAccount(user.api);
	return { address, fake, admin, user, id };
}

const addMail = (fake: Fake, subject: string) =>
	fake.addMessage("INBOX", {
		raw: sampleMessage(1, { subject, messageId: `<${subject.replace(/\W+/g, "-")}@example.org>` }),
	});

async function findMessage(api: APIRequestContext, subject: string, status: string): Promise<ListedMessage | null> {
	const query = new URLSearchParams({ q: `"${subject}"`, status, limit: "5" });
	const response = await api.get(`/api/messages?${query}`);
	expect(response.ok()).toBe(true);
	const { messages } = (await response.json()) as { messages: ListedMessage[] };
	return messages.find((message) => message.subject === subject) ?? null;
}

async function pendingChanges(api: APIRequestContext, id: string) {
	const response = await api.get(`/api/external-accounts/${id}/two-way`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { twoWay: { pending: number } }).twoWay.pending;
}

const bulk = (api: APIRequestContext, action: string, messageIds: string[]) =>
	api.post("/api/messages/bulk", { data: { action, messageIds } });

const atProvider = (fake: Fake, folder: string, subject: string) =>
	(fake.listMessages(folder) as { flags: string[]; raw: string }[]).find((message) =>
		message.raw.includes(`Subject: ${subject}`),
	);

async function openTwoWay(page: Page, address: string) {
	await page.goto("/settings/connected-accounts");
	const panel = page.locator(`[data-account-two-way="${address}"]`);
	await panel.getByRole("button", { name: "Two-way sync" }).click();
	await expect(panel.getByRole("combobox", { name: "Delete in Kite" })).toBeVisible({ timeout: 30_000 });
	return panel;
}

test("with the settings off nothing changes at the provider, and nothing comes back from it", async () => {
	test.setTimeout(180_000);
	const token = uniqueToken("xtwo");
	const { fake, admin, user, id } = await setup(token);
	try {
		const subject = `${token} stays`;
		const uid = addMail(fake, subject);
		await runCheck(user.api, admin, id);
		await waitForMessage(user.api, subject);
		const message = (await findMessage(user.api, subject, "received"))!;
		expect((await bulk(user.api, "trash", [message.id])).ok()).toBe(true);
		fake.setFlags("INBOX", uid, ["\\Seen"]);
		await runCheck(user.api, admin, id);
		expect(atProvider(fake, "INBOX", subject)).toBeTruthy();
		expect((await findMessage(user.api, subject, "trash"))?.read).toBe(false);
		expect(fake.commands.filter((command) => WRITES.test(command.line))).toEqual([]);
	} finally {
		await fake.close();
	}
});

test("each setting works both ways, and a trash move is a move, never an expunge", async ({ browser }) => {
	test.setTimeout(300_000);
	const token = uniqueToken("xtwo");
	const { address, fake, admin, user, id } = await setup(token);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	const page = await context.newPage();
	try {
		const subjects = {
			deleted: `${token} deleted in Kite`,
			archived: `${token} archived in Kite`,
			spam: `${token} spam in Kite`,
			read: `${token} read in Kite`,
			starred: `${token} starred in Kite`,
			goneThere: `${token} deleted at the provider`,
			flagsThere: `${token} flags at the provider`,
		};
		const uids = Object.fromEntries(Object.entries(subjects).map(([key, subject]) => [key, addMail(fake, subject)]));
		await runCheck(user.api, admin, id);
		for (const subject of Object.values(subjects)) await waitForMessage(user.api, subject);

		// The settings, from the account row: off until chosen, and saved one by one.
		const panel = await openTwoWay(page, address);
		const choose = (name: string, label: string) =>
			chooseOption(panel.getByRole("combobox", { name, exact: true }), { label });
		await expect(panel.getByRole("combobox", { name: "Delete in Kite" })).toHaveText(/Nothing/);
		await choose("Delete in Kite", "Move to the provider's Trash");
		await choose("Archive in Kite", "Archive at the provider");
		await choose("Move to Spam in Kite", "Move to the provider's Spam");
		await choose("Read, unread and star in Kite", "On");
		await choose("Deleted or moved out of the Inbox", "Move to Kite's Trash");
		await choose("Read, unread and star at the provider", "On");
		await expect(panel.getByRole("combobox", { name: "Read, unread and star at the provider" })).toHaveText(/On/);
		await page.reload();
		const saved = await openTwoWay(page, address);
		await expect(saved.getByRole("combobox", { name: "Delete in Kite" })).toHaveText(/Move to the provider's Trash/);

		// The first check takes the baseline.
		await runCheck(user.api, admin, id);

		const idOf = async (subject: string) => (await findMessage(user.api, subject, "received"))!.id;
		expect((await bulk(user.api, "trash", [await idOf(subjects.deleted)])).ok()).toBe(true);
		expect((await bulk(user.api, "archive", [await idOf(subjects.archived)])).ok()).toBe(true);
		expect((await bulk(user.api, "spam", [await idOf(subjects.spam)])).ok()).toBe(true);
		expect((await bulk(user.api, "read", [await idOf(subjects.read)])).ok()).toBe(true);
		expect((await user.api.post(`/api/messages/${await idOf(subjects.starred)}/star`)).ok()).toBe(true);

		// Inside the delay nothing has moved, even after a regular check; the queued run then does it by itself.
		await runCheck(user.api, admin, id);
		expect(atProvider(fake, "INBOX", subjects.deleted)).toBeTruthy();
		await expect.poll(() => !!atProvider(fake, "Trash", subjects.deleted), { timeout: 120_000 }).toBe(true);

		expect(atProvider(fake, "INBOX", subjects.deleted)).toBeUndefined();
		expect(atProvider(fake, "Archive", subjects.archived)).toBeTruthy();
		expect(atProvider(fake, "Junk", subjects.spam)).toBeTruthy();
		expect(atProvider(fake, "INBOX", subjects.read)?.flags).toEqual(["\\Seen"]);
		expect(atProvider(fake, "INBOX", subjects.starred)?.flags).toEqual(["\\Flagged"]);
		const lines = fake.commands.map((command) => command.line);
		expect(lines.some((line) => /UID MOVE \d+ "Trash"/.test(line))).toBe(true);
		expect(lines.some((line) => /EXPUNGE|\\Deleted/i.test(line))).toBe(false);

		// From the provider: flags at the next check, a deletion only once a second session agrees.
		fake.removeMessage("INBOX", uids.goneThere);
		fake.setFlags("INBOX", uids.flagsThere, ["\\Seen", "\\Flagged"]);
		await runCheck(user.api, admin, id);
		expect(await findMessage(user.api, subjects.flagsThere, "received")).toMatchObject({ read: true, starred: true });
		expect(await findMessage(user.api, subjects.goneThere, "received")).toBeTruthy();
		await runCheck(user.api, admin, id);
		await expect.poll(() => findMessage(user.api, subjects.goneThere, "trash")).toBeTruthy();
		expect(await findMessage(user.api, subjects.goneThere, "trash")).toMatchObject({ status: "trash" });

		// What Kite did at the provider is not read back as a change, and what came from the provider does not go back.
		const stored = fake.commands.length;
		await runCheck(user.api, admin, id);
		expect(fake.commands.slice(stored).filter((command) => /STORE|MOVE/i.test(command.line))).toEqual([]);
		expect(await findMessage(user.api, subjects.archived, "archived")).toBeTruthy();
	} finally {
		await context.close();
		await fake.close();
	}
});

test("a provider that rebuilt its Inbox moves and trashes nothing", async () => {
	test.setTimeout(180_000);
	const token = uniqueToken("xtwo");
	const { fake, admin, user, id } = await setup(token);
	try {
		const subject = `${token} after the rebuild`;
		addMail(fake, subject);
		await runCheck(user.api, admin, id);
		await waitForMessage(user.api, subject);
		const saved = await user.api.put(`/api/external-accounts/${id}/two-way`, {
			data: { ...OFF, kiteDelete: "trash", providerGone: "trash", providerFlags: true },
		});
		expect(saved.ok()).toBe(true);
		await runCheck(user.api, admin, id);

		addMail(fake, `${token} deleted before the rebuild`);
		await runCheck(user.api, admin, id);
		await waitForMessage(user.api, `${token} deleted before the rebuild`);
		const message = (await findMessage(user.api, `${token} deleted before the rebuild`, "received"))!;
		expect((await bulk(user.api, "trash", [message.id])).ok()).toBe(true);
		fake.bumpUidValidity("INBOX");
		await runCheck(user.api, admin, id);
		await expect.poll(() => pendingChanges(user.api, id), { timeout: 120_000 }).toBe(0);
		await runCheck(user.api, admin, id);

		expect(fake.listMessages("Trash")).toEqual([]);
		expect(fake.commands.some((command) => /MOVE|EXPUNGE/i.test(command.line))).toBe(false);
		expect(await findMessage(user.api, subject, "received")).toBeTruthy();
	} finally {
		await fake.close();
	}
});

test("a move the provider refuses stays waiting and shows in the account's problems", async ({ browser }) => {
	test.setTimeout(180_000);
	const token = uniqueToken("xtwo");
	const { address, fake, admin, user, id } = await setup(token);
	const context = await browser.newContext({ storageState: await user.api.storageState() });
	const page = await context.newPage();
	try {
		const subject = `${token} refused`;
		addMail(fake, subject);
		await runCheck(user.api, admin, id);
		await waitForMessage(user.api, subject);
		expect(
			(await user.api.put(`/api/external-accounts/${id}/two-way`, { data: { ...OFF, kiteDelete: "trash" } })).ok(),
		).toBe(true);
		fake.refuseWrite("MOVE", "NO [OVERQUOTA] Trash is full");
		const message = (await findMessage(user.api, subject, "received"))!;
		expect((await bulk(user.api, "trash", [message.id])).ok()).toBe(true);
		await expect
			.poll(() => fake.commands.some((command) => /UID MOVE/.test(command.line)), { timeout: 120_000 })
			.toBe(true);

		const panel = await openTwoWay(page, address);
		await expect(panel.locator("[data-two-way-pending]")).toContainText("1 change is waiting");
		await expect(panel.locator("[data-two-way-problems]")).toContainText("Trash is full");
		expect(atProvider(fake, "INBOX", subject)).toBeTruthy();
	} finally {
		await context.close();
		await fake.close();
	}
});
