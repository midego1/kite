import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { beginAutoReadSnapshot, restoreAutoReadSnapshot } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { QUESTION_DRAFT_BODY } from "./support/fake-model-scenarios";
import type { FakeModel } from "./support/fake-model-types";
import {
	deliverInvite,
	deliverPhishing,
	deliverReply,
	openAs,
	suggestAccount,
	type ForYouAccount,
} from "./support/for-you";
import { apiContext } from "./support/helpers";
import { readSuggestions } from "./support/triage";

// The hover preview of a For you row (src/components/agent/suggestion-preview*.tsx), on the For you page and the
// command center's card: sender, subject, an excerpt, the suggestion's own block from the reader card with its
// actions, and Dismiss. Suggestions come from the fake model and the deterministic invite and phishing steps.

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

/** The left of a row, which an open preview (aligned to the row's end) does not cover. */
const START = { x: 12, y: 10 };
const popover = (page: Page) => page.locator("[data-suggestion-preview-popover]");
const pageEntry = (page: Page, subject: string) => page.locator("[data-for-you-entry]", { hasText: subject });
const cardEntry = (page: Page, subject: string) =>
	page.getByTestId("command-center-for-you").locator("[data-for-you-card-entry]", { hasText: subject });

/** A reply, a phishing warning and an invitation for one account, each triaged. */
async function setUp() {
	const account = await suggestAccount(api, "fyp");
	const reply = await deliverReply(account, account.mailboxId, account.address, "Customer <customer@outside.test>");
	const phishing = await deliverPhishing(account, account.mailboxId, account.address);
	const invite = await deliverInvite(account, account.mailboxId, account.address);
	await expect
		.poll(async () => (await readSuggestions(account.api, { status: "open" })).total)
		.toBeGreaterThanOrEqual(3);
	return { account, reply, phishing, invite };
}

async function closeAll(account: ForYouAccount, restore: () => Promise<void>, context: { close: () => Promise<void> }) {
	await context.close();
	await account.api.dispose();
	await restore();
}

test("hovering a For you row previews the message and the reader card's actions, and Escape closes it", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply, phishing, invite } = await setUp();
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		const fetched: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith("/api/messages/") && request.method() === "GET") fetched.push(url.pathname);
		});
		await page.goto("/for-you");
		await expect(page.locator("[data-for-you-entry]")).toHaveCount(3);
		await expect(popover(page)).toHaveCount(0);

		// A reply: who, what, the message's words, the drafted reply, and the reader card's two buttons plus Dismiss.
		await pageEntry(page, reply.subject!).hover({ position: START });
		const open = popover(page);
		await expect(open).toBeVisible();
		await expect(open).toContainText("Customer");
		await expect(open).toContainText("customer@outside.test");
		await expect(open).toContainText(reply.subject!);
		await expect(open.getByTestId("suggestion-preview-excerpt")).toContainText("Can you confirm the order?");
		await expect(open.getByTestId("suggestion-preview-draft")).toContainText(QUESTION_DRAFT_BODY.slice(0, 20));
		await expect(open.getByRole("button", { name: "Review draft" })).toBeVisible();
		await expect(open.getByRole("button", { name: "Discard" })).toBeVisible();
		await expect(open.getByRole("button", { name: "Dismiss" })).toBeVisible();
		// Nothing was sent: the reply is only ever opened as a draft.
		await expect(open.getByRole("button", { name: /^send/i })).toHaveCount(0);
		// A click on its plain text takes no focus target: the preview stays while the pointer is in it.
		await open.getByText("Message", { exact: true }).click();
		await page.waitForTimeout(600);
		await expect(open).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);

		// Moving between rows and back asks for the message once: the excerpt and the draft are cached.
		const before = fetched.length;
		await pageEntry(page, phishing.subject!).hover({ position: START });
		await expect(popover(page)).toContainText("A link shows one web address but opens a different one.");
		await expect(popover(page).getByRole("button", { name: "Not phishing" })).toBeVisible();
		await expect(popover(page).getByRole("button", { name: "Report phishing" })).toBeVisible();
		await pageEntry(page, reply.subject!).hover({ position: START });
		await expect(popover(page)).toContainText(reply.subject!);
		await pageEntry(page, reply.subject!).hover({ position: { x: 40, y: 8 } });
		await page.mouse.move(50, 10, { steps: 8 });
		expect(fetched.filter((path) => path.endsWith(reply.id)).length).toBeLessThanOrEqual(1);
		expect(fetched.length - before).toBeLessThanOrEqual(2);

		// An invitation: its time and the reader card's answers, which still confirm before anything is sent.
		await pageEntry(page, invite.subject!).hover({ position: START });
		await expect(popover(page)).toContainText("Planning");
		await expect(popover(page).getByRole("button", { name: "Accept" })).toBeVisible();
		await expect(popover(page).getByRole("button", { name: "Decline" })).toBeVisible();
		await expect(popover(page).getByRole("button", { name: "Propose new time" })).toBeVisible();
		await expect(popover(page).locator("[data-invite-warnings]")).toContainText("Unverified sender");
	} finally {
		await closeAll(account, restore, context);
	}
});

test("the preview's Dismiss closes the suggestion with an Undo toast, from the command center card too", async ({
	browser,
}) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply, phishing } = await setUp();
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/inbox");
		await expect(page.getByTestId("command-center-for-you")).toBeVisible();
		await cardEntry(page, phishing.subject!).hover();
		await expect(popover(page)).toBeVisible();
		await popover(page).getByRole("button", { name: "Dismiss" }).click();
		await expect(page.getByText("Suggestion dismissed")).toBeVisible();
		await expect(cardEntry(page, phishing.subject!)).toHaveCount(0);
		await expect(popover(page)).toHaveCount(0);
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(cardEntry(page, phishing.subject!)).toBeVisible();

		// Review draft opens the draft; the reply is not sent.
		await cardEntry(page, reply.subject!).hover();
		await popover(page).getByRole("button", { name: "Review draft" }).click();
		await expect(page).not.toHaveURL(/\/inbox$/);
		const open = (await readSuggestions(account.api, { mailboxId: account.mailboxId, status: "open" })).suggestions;
		expect(open.some((item) => item.messageId === reply.id)).toBe(true);
	} finally {
		await closeAll(account, restore, context);
	}
});

test("keyboard focus opens the preview, Tab goes row to row and ArrowDown moves into it", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply } = await setUp();
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/for-you");
		const link = pageEntry(page, reply.subject!).getByRole("link").first();
		await expect(link).toBeVisible();
		// Tab until the row's link has focus, as a keyboard user would.
		for (let step = 0; step < 40 && !(await link.evaluate((node) => node === document.activeElement)); step++)
			await page.keyboard.press("Tab");
		await expect(link).toBeFocused();
		await expect(popover(page)).toBeVisible();
		await expect(popover(page)).toContainText(reply.subject!);
		await expect(popover(page).getByRole("button", { name: "Review draft" })).toBeVisible();
		// The link says how to reach the preview's buttons.
		await expect(link).toHaveAccessibleDescription(/down arrow/i);
		// The link says how to reach the preview's buttons.
		await expect(link).toHaveAccessibleDescription(/down arrow/i);
		// Its controls are out of the Tab order: Tab leaves the row (to the next row, whose own preview opens) and its preview closes.
		await page.keyboard.press("Tab");
		await expect(popover(page).filter({ hasText: reply.subject! })).toHaveCount(0);
		await expect(link).not.toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(link).toBeFocused();
		await expect(popover(page)).toBeVisible();
		// ArrowDown moves focus into the preview, whose buttons then take Tab; Escape closes it and returns to the row.
		await page.keyboard.press("ArrowDown");
		const review = popover(page).getByRole("button", { name: "Review draft" });
		await expect(review).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(popover(page).getByRole("button", { name: "Discard" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);
		await expect(link).toBeFocused();
		// Focus handed back to the row does not open the preview again.
		await page.waitForTimeout(700);
		await expect(popover(page)).toHaveCount(0);
		// Opened again by keyboard after having been entered once, it starts out of the Tab order once more.
		await page.keyboard.press("Tab");
		await page.keyboard.press("Shift+Tab");
		await expect(link).toBeFocused();
		await expect(popover(page).filter({ hasText: reply.subject! })).toBeVisible();
		await page.keyboard.press("Tab");
		await expect(popover(page).filter({ hasText: reply.subject! })).toHaveCount(0);
	} finally {
		await closeAll(account, restore, context);
	}
});

test("on touch nothing opens on hover and a tap still opens the message", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply } = await setUp();
	const { context, page } = await openAs(browser, account, account.mailboxId, { hasTouch: true });
	try {
		await page.goto("/for-you");
		const entry = pageEntry(page, reply.subject!);
		await expect(entry).toBeVisible();
		await entry.getByRole("link").first().tap();
		await expect(page).toHaveURL(/\/inbox\/msg_/);
		await expect(popover(page)).toHaveCount(0);
	} finally {
		await closeAll(account, restore, context);
	}
});

test("the preview stays inside a narrow pane, in a right-to-left interface too", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply } = await setUp();
	for (const rtl of [false, true]) {
		const { context, page } = await openAs(browser, account, account.mailboxId, {
			viewport: { width: 1040, height: 800 },
		});
		try {
			await page.addInitScript((direction) => {
				if (direction) localStorage.setItem("kite-interface-direction", "rtl");
			}, rtl);
			await page.goto("/inbox");
			await expect(page.locator("html")).toHaveAttribute("dir", rtl ? "rtl" : "ltr");
			await cardEntry(page, reply.subject!).hover();
			await expect(popover(page)).toBeVisible();
			const box = (await popover(page).boundingBox())!;
			const viewport = page.viewportSize()!;
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		} finally {
			await context.close();
		}
	}
	await account.api.dispose();
	await restore();
});

test("Dismiss and a card action inside the preview return focus to the row", async ({ browser }) => {
	const restore = await useFakeProvider(api, fake);
	const { account, reply, phishing } = await setUp();
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/for-you");

		// A card action (Discard, inside the reader card's block) resolves the suggestion; the reply row's
		// own request to discard its draft disables the button clicked, which used to blur focus to nowhere
		// instead of handing it back to the row.
		const replyLink = pageEntry(page, reply.subject!).getByRole("link").first();
		await pageEntry(page, reply.subject!).hover({ position: START });
		await expect(popover(page)).toBeVisible();
		await popover(page).getByRole("button", { name: "Discard" }).click();
		await expect(popover(page)).toHaveCount(0);
		await expect(replyLink).toBeFocused();

		// The preview's own Dismiss does the same.
		const phishingLink = pageEntry(page, phishing.subject!).getByRole("link").first();
		await pageEntry(page, phishing.subject!).hover({ position: START });
		await expect(popover(page)).toBeVisible();
		await popover(page).getByRole("button", { name: "Dismiss" }).click();
		await expect(popover(page)).toHaveCount(0);
		await expect(phishingLink).toBeFocused();
	} finally {
		await closeAll(account, restore, context);
	}
});
