import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import {
	beginAutoReadSnapshot,
	createSharedMailbox,
	okJson,
	restoreAutoReadSnapshot,
	shareMailbox,
} from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, uniqueToken } from "./support/helpers";
import { deliverPhishing, deliverReply, openAs, suggestAccount } from "./support/for-you";
import { readSuggestions } from "./support/triage";

// The command center's For you card (src/components/command-center/for-you-card.tsx): the newest open suggestions
// of the mailboxes in view, with an inline Dismiss and a link to the For you page, drawn from the list the sidebar
// item shares. The suggestions come from the fake model (e2e/support/fake-model.ts), as in 23-auto-agent.

let fake: FakeModel;
let api: APIRequestContext;

test.beforeAll(async () => {
	fake = await startFakeModel();
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
	await fake.close();
});

test.beforeEach(async () => {
	fake.clearRequests();
	fake.resetDefaultScenario();
	await beginAutoReadSnapshot(api);
});

test.afterEach(async () => {
	await restoreAutoReadSnapshot();
});

const pane = (page: Page) => page.getByTestId("reading-pane-empty");
const card = (page: Page) => pane(page).getByTestId("command-center-for-you");
const entries = (page: Page) => card(page).locator("[data-for-you-card-entry]");

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(pane(page).getByRole("heading", { level: 2 })).toBeVisible();
}

test("the card lists the newest suggestions of the mailbox in view, dismisses inline and says when nothing is left", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const account = await suggestAccount(api, "ccf");
	const sharedLocal = `ccfs${uniqueToken("")}`;
	const sharedId = await createSharedMailbox(api, sharedLocal);
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await shareMailbox(api, sharedId, account.id, "full_access");
		await okJson(await api.put("/api/agent/settings", { data: { mailboxId: sharedId, autonomy: "suggest" } }));
		const sharedAddress = `${sharedLocal}@${DOMAIN}`;
		const reply = await deliverReply(account, account.mailboxId, account.address, "Customer <customer@outside.test>");
		const phishing = await deliverPhishing(account, account.mailboxId, account.address);
		// The shared mailbox is the admin's to manage, so the admin's session reads its jobs.
		const shared = await deliverReply(account, sharedId, sharedAddress, "Client <client@outside.test>", api);
		// Both suggestions of the first two messages are open, and the shared mailbox has its own.
		await expect
			.poll(async () => (await readSuggestions(account.api, { status: "open" })).total)
			.toBeGreaterThanOrEqual(3);

		await openInbox(page);
		const entryFor = (subject: string) => entries(page).filter({ hasText: subject });
		await expect(card(page)).toBeVisible();
		await expect(card(page).getByRole("heading", { level: 3 })).toHaveText("For you");
		// The count that was a tile is in the card; the tile is gone.
		await expect(pane(page).locator("[data-chip=for-you]")).toHaveCount(0);
		await expect(card(page).locator("[data-command-center-count]")).toHaveText("2");
		await expect(entries(page)).toHaveCount(2);
		await expect(entryFor(reply.subject!)).toHaveAttribute("data-kind", "reply");
		await expect(entryFor(reply.subject!)).toContainText("Reply · Customer");
		await expect(entryFor(phishing.subject!)).toHaveAttribute("data-kind", "phishing");
		await expect(entryFor(phishing.subject!)).toContainText("Phishing · Bank");
		await expect(entryFor(shared.subject!)).toHaveCount(0);
		await expect(entryFor(reply.subject!).getByRole("link")).toHaveAttribute("href", /message=|\/inbox/);
		await expect(card(page).getByRole("link", { name: "Open For you" })).toHaveAttribute("href", "/for-you");

		// The same list, with the All mailboxes view: the shared mailbox's suggestion joins.
		await page.evaluate(() => localStorage.setItem("kite-all-mailboxes", "true"));
		await openInbox(page);
		await expect(card(page).locator("[data-command-center-count]")).toHaveText("3");
		await expect(entryFor(shared.subject!)).toHaveCount(1);
		await page.evaluate(() => localStorage.removeItem("kite-all-mailboxes"));
		await openInbox(page);
		await expect(entries(page)).toHaveCount(2);

		// Dismiss works like the reader card's: the suggestion closes, the count follows, Undo brings it back.
		await entryFor(reply.subject!)
			.getByRole("button", { name: `Dismiss ${reply.subject}` })
			.click();
		await expect(page.getByText("Suggestion dismissed")).toBeVisible();
		await expect(entries(page)).toHaveCount(1);
		await expect(card(page).locator("[data-command-center-count]")).toHaveText("1");
		const open = async () =>
			(await readSuggestions(account.api, { mailboxId: account.mailboxId, status: "open" })).suggestions.map(
				(item) => item.messageId,
			);
		await expect.poll(open).not.toContain(reply.id);
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(entries(page)).toHaveCount(2);
		await expect.poll(open).toContain(reply.id);

		// Dismissing both leaves the quiet state, which keeps the way to the For you page.
		await entryFor(reply.subject!)
			.getByRole("button", { name: `Dismiss ${reply.subject}` })
			.click();
		await expect(entries(page)).toHaveCount(1);
		await entryFor(phishing.subject!)
			.getByRole("button", { name: `Dismiss ${phishing.subject}` })
			.click();
		await expect(entries(page)).toHaveCount(0);
		await expect(card(page).locator("[data-command-center-empty]")).toContainText("Nothing for you right now.");
		await expect(card(page).locator("[data-command-center-empty]").getByRole("link")).toHaveAttribute(
			"href",
			"/for-you",
		);
		await expect(card(page).locator("[data-command-center-count]")).toHaveText("0");
	} finally {
		await context.close();
		await account.api.dispose();
		await restore();
	}
});

test("the card is left out while automatic reading is off or the mailbox has no AI, and for mail you cannot review", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const account = await suggestAccount(api, "ccg");
	const sharedLocal = `ccgs${uniqueToken("")}`;
	const sharedId = await createSharedMailbox(api, sharedLocal);
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await deliverReply(account, account.mailboxId, account.address, "Customer <customer@outside.test>");
		await openInbox(page);
		await expect(card(page)).toBeVisible();

		await okJson(
			await account.api.put("/api/agent/settings/ai", { data: { mailboxId: account.mailboxId, aiDisabled: true } }),
		);
		await openInbox(page);
		await expect(card(page)).toHaveCount(0);
		await okJson(
			await account.api.put("/api/agent/settings/ai", { data: { mailboxId: account.mailboxId, aiDisabled: false } }),
		);

		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "off" } }),
		);
		await openInbox(page);
		await expect(card(page)).toHaveCount(0);
		await expect(pane(page).locator("[data-chip=for-you]")).toHaveCount(0);

		// A mailbox shared read-only is no full access: its suggestions are not the account's to review.
		await okJson(await api.put("/api/agent/settings", { data: { mailboxId: sharedId, autonomy: "suggest" } }));
		await shareMailbox(api, sharedId, account.id, "read_only");
		await page.evaluate(() => localStorage.setItem("kite-all-mailboxes", "true"));
		await openInbox(page);
		await expect(card(page)).toHaveCount(0);
	} finally {
		await context.close();
		await account.api.dispose();
		await restore();
	}
});
