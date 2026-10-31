import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Once the open message leaves the list (Trash, a spam report, ...), the reader goes back to the empty pane at
// once, in list and conversation view, and Undo puts the message back in the list. The reader used to wait for
// the route change to the list, which can take a while on a deployed Worker, so it kept showing the message.

const EMPTY_READER = "Select a message to read";
/** How long the list route's server payload is held back, standing in for a slow deployed Worker. */
const SLOW_NAVIGATION_MS = 8_000;

/** Holds back the RSC fetch of the list route (not the API calls), so a reader that waits for it stays open. */
async function slowListNavigation(page: Page) {
	await page.route(
		(url) => url.pathname === "/inbox",
		async (route) => {
			if (route.request().resourceType() !== "document")
				await new Promise((resolve) => setTimeout(resolve, SLOW_NAVIGATION_MS));
			await route.continue();
		},
	);
}

async function deliver(label: string) {
	const api = await apiContext(STORAGE_STATE);
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Reader Sender" <${uniqueToken("rd")}@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Body of ${label}.`,
	});
	return { api, subject, id: message.id };
}

async function statusOf(api: Awaited<ReturnType<typeof apiContext>>, id: string) {
	const response = await api.get(`/api/messages/${id}`);
	return ((await response.json()) as { message?: { status: string } }).message?.status;
}

const rows = (page: Page, subject: string) => page.getByRole("main").locator("div.group").filter({ hasText: subject });

async function openFromList(page: Page, subject: string) {
	await page.goto("/inbox");
	await rows(page, subject).first().click();
	await expect(page.getByRole("heading", { name: subject })).toBeVisible();
	await expect(page.getByText(EMPTY_READER)).toHaveCount(0);
	await slowListNavigation(page);
}

/**
 * The reader is empty well before the slow list route could have answered, and the keyboard focus moved to the
 * list instead of being dropped on the page.
 */
async function expectReaderEmpty(page: Page, subject: string) {
	await expect(page.getByText(EMPTY_READER)).toBeVisible({ timeout: SLOW_NAVIGATION_MS / 2 });
	await expect(page.getByRole("heading", { name: subject })).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="list"]'))).toBe(true);
}

for (const view of ["conversation", "list"] as const) {
	test.describe(`${view} view`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript(
				(value) => localStorage.setItem("kite-conversation-view", value),
				view === "conversation" ? "on" : "off",
			);
		});

		test("Move to trash in the reader empties the reader, and Undo puts the message back", async ({ page }) => {
			const { api, subject, id } = await deliver(`Reader trash ${view}`);
			try {
				await openFromList(page, subject);
				await page.getByRole("button", { name: /^Move to trash/ }).click();
				const toast = page.getByRole("status").filter({ hasText: "Message moved to Trash" });
				await expect(toast).toBeVisible();
				await expectReaderEmpty(page, subject);
				await expect(rows(page, subject)).toHaveCount(0);
				await expect(page).toHaveURL(/\/inbox$/);

				await toast.getByRole("button", { name: "Undo" }).click();
				await expect.poll(() => statusOf(api, id)).toBe("received");
				await expect(rows(page, subject)).toHaveCount(1);
			} finally {
				await api.dispose();
			}
		});

		test("Report spam in the reader empties the reader and removes the row", async ({ page }) => {
			const { api, subject, id } = await deliver(`Reader spam ${view}`);
			try {
				await openFromList(page, subject);
				await page.getByRole("button", { name: /^Report spam/ }).click();
				await page
					.getByRole("alertdialog", { name: "Report as spam?" })
					.getByRole("button", { name: "Report spam" })
					.click();
				await expectReaderEmpty(page, subject);
				await expect(rows(page, subject)).toHaveCount(0);
				await expect.poll(() => statusOf(api, id)).toBe("spam");
			} finally {
				await api.dispose();
			}
		});
	});
}

test("trashing the open message from its row empties the reader too", async ({ page }) => {
	const { api, subject } = await deliver("Row trash");
	try {
		await openFromList(page, subject);
		const row = rows(page, subject).first();
		await row.hover();
		await row.getByRole("button", { name: "Trash", exact: true }).click();
		await expectReaderEmpty(page, subject);
		await expect(rows(page, subject)).toHaveCount(0);
	} finally {
		await api.dispose();
	}
});

test("trashing a deep-linked older message of a conversation hands the focus to the next row", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("kite-conversation-view", "on"));
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken("deep");
	const subject = `Deep link ${token}`;
	const from = `"Reader Sender" <${token}@outside.test>`;
	const messageId = `<${token}-first@outside.test>`;
	try {
		// A message below the conversation, so the focus has a row to go to.
		await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject: `Neighbour ${token}`, text: "Below." });
		const first = await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject, text: "First.", messageId });
		const reply = await deliverInbound(api, {
			from,
			to: SUPPORT_ADDRESS,
			subject: `Re: ${subject}`,
			text: "Second.",
			inReplyTo: messageId,
		});
		expect(reply.threadId).toBe(first.threadId);

		// The row stands for the conversation and is keyed by the reply; the link opens the older message.
		await page.goto(`/inbox/${first.id}`);
		await expect(rows(page, `Re: ${subject}`)).toHaveCount(1);
		await expect(page.getByText(EMPTY_READER)).toHaveCount(0);
		await page.getByRole("button", { name: /^Move to trash/ }).click();
		await expect(page.getByText(EMPTY_READER)).toBeVisible();
		await expect(rows(page, `Re: ${subject}`)).toHaveCount(0);
		await expect
			.poll(() => Promise.all([statusOf(api, first.id), statusOf(api, reply.id)]))
			.toEqual(["trash", "trash"]);
		await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-message-row]"))).toBe(true);
	} finally {
		await api.dispose();
	}
});
