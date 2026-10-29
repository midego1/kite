import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

const FROM = `"Picker" <picker@outside.test>`;

async function deliverMany(labels: string[]): Promise<string[]> {
	const api = await apiContext(STORAGE_STATE);
	const subjects: string[] = [];
	for (const label of labels) {
		const subject = `${label} ${uniqueToken()}`;
		await deliverInbound(api, { from: FROM, to: SUPPORT_ADDRESS, subject });
		subjects.push(subject);
	}
	await api.dispose();
	return subjects;
}

/** The list row for a subject, whether the list is wide or stacked beside the reading pane. */
function rowFor(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

const subjectOf = (page: Page, subject: string) => rowFor(page, subject).getByText(subject, { exact: true });
const checkbox = (page: Page, subject: string) => rowFor(page, subject).getByRole("checkbox");

test("click, then Shift-click four rows down selects all five and shows the bulk toolbar", async ({ page }) => {
	// Delivered oldest first, so the list shows them newest first: F, E, D, C, B, A.
	const [a, b, c, d, e, f] = await deliverMany(["Mod A", "Mod B", "Mod C", "Mod D", "Mod E", "Mod F"]);
	await page.goto("/inbox");
	await expect(subjectOf(page, f)).toBeVisible();

	await subjectOf(page, f).click();
	await expect(page).toHaveURL(/\/msg_[\w-]+/);
	const openUrl = page.url();
	await subjectOf(page, b).click({ modifiers: ["Shift"] });

	for (const subject of [f, e, d, c, b]) await expect(checkbox(page, subject)).toBeChecked();
	await expect(checkbox(page, a)).not.toBeChecked();
	await expect(page.getByText("5 selected")).toBeVisible();
	await expect(page.getByRole("button", { name: "Clear selection" }).first()).toBeVisible();
	// The click selected: it neither opened another message nor selected text.
	expect(page.url()).toBe(openUrl);
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

	// Shift-click again extends from the same anchor, in either direction.
	await subjectOf(page, d).click({ modifiers: ["Shift"] });
	await expect(page.getByText("3 selected")).toBeVisible();
	await expect(checkbox(page, c)).not.toBeChecked();
});

test("Ctrl/Cmd-click toggles a row without opening it, and the open message joins first", async ({ page }) => {
	const [a, b, c, d] = await deliverMany(["Tog A", "Tog B", "Tog C", "Tog D"]);
	await page.goto("/inbox");
	await expect(subjectOf(page, d)).toBeVisible();

	// With nothing open the click only selects.
	await subjectOf(page, c).click({ modifiers: ["ControlOrMeta"] });
	await expect(checkbox(page, c)).toBeChecked();
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(page).toHaveURL(/\/inbox$/);
	await subjectOf(page, c).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("1 selected")).toHaveCount(0);

	// One message open, then Ctrl/Cmd-click another: both are selected.
	await subjectOf(page, d).click();
	await expect(page).toHaveURL(/\/msg_[\w-]+/);
	await subjectOf(page, b).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("2 selected")).toBeVisible();
	await expect(checkbox(page, d)).toBeChecked();
	await expect(checkbox(page, b)).toBeChecked();

	await subjectOf(page, a).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("3 selected")).toBeVisible();
	await subjectOf(page, b).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("2 selected")).toBeVisible();
	await expect(checkbox(page, b)).not.toBeChecked();

	// Ctrl/Cmd+Shift adds a range to the selection.
	await subjectOf(page, c).click({ modifiers: ["ControlOrMeta", "Shift"] });
	await expect(checkbox(page, c)).toBeChecked();
	await expect(checkbox(page, a)).toBeChecked();
	await expect(checkbox(page, d)).toBeChecked();
});

test("a Shift-click range in conversation view carries every message of each conversation", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const [before] = await deliverMany(["Conv before"]);
	const subject = `Conv thread ${uniqueToken()}`;
	const rootId = `<${uniqueToken("root")}@outside.test>`;
	const root = await deliverInbound(api, { from: FROM, to: SUPPORT_ADDRESS, subject, messageId: rootId });
	const replySubject = `Re: ${subject}`;
	const reply = await deliverInbound(api, {
		from: FROM,
		to: SUPPORT_ADDRESS,
		subject: replySubject,
		inReplyTo: rootId,
	});
	expect(reply.threadId).toBe(root.threadId);
	const [after] = await deliverMany(["Conv after"]);

	await page.goto("/inbox");
	// The conversation is one row, titled by its newest message: after, thread, before.
	await expect(subjectOf(page, after)).toBeVisible();
	await expect(rowFor(page, replySubject)).toHaveCount(1);
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);

	await subjectOf(page, after).click();
	await expect(page).toHaveURL(/\/msg_[\w-]+/);
	await subjectOf(page, before).click({ modifiers: ["Shift"] });
	await expect(page.getByText("3 selected")).toBeVisible();
	await expect(checkbox(page, replySubject)).toBeChecked();

	// Archiving the three rows archives all four messages.
	await page
		.getByText("3 selected")
		.first()
		.locator("..")
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect(rowFor(page, replySubject)).toHaveCount(0);
	const params = new URLSearchParams({ status: "archived", mailboxId: root.mailboxId, limit: "100" });
	const archived = (await (await api.get(`/api/messages?${params}`)).json()) as { messages: Array<{ id: string }> };
	const ids = archived.messages.map((message) => message.id);
	expect(ids).toContain(root.id);
	expect(ids).toContain(reply.id);
	await api.dispose();
});

test("Escape clears the selection", async ({ page }) => {
	const [a, b, c] = await deliverMany(["Esc A", "Esc B", "Esc C"]);
	await page.goto("/inbox");
	await expect(subjectOf(page, c)).toBeVisible();

	await subjectOf(page, c).click({ modifiers: ["ControlOrMeta"] });
	await subjectOf(page, a).click({ modifiers: ["Shift"] });
	await expect(page.getByText("3 selected")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
	for (const subject of [a, b, c]) await expect(checkbox(page, subject)).not.toBeChecked();
});

test("Shift+Arrow extends the selection from the focused row", async ({ page }) => {
	const [, , c, d, e] = await deliverMany(["Key A", "Key B", "Key C", "Key D", "Key E"]);
	await page.goto("/inbox");
	await expect(subjectOf(page, e)).toBeVisible();

	// j focuses the first row (E); Shift+Down extends to D and C.
	await page.keyboard.press("j");
	await page.keyboard.press("Shift+ArrowDown");
	await expect(page.getByText("2 selected")).toBeVisible();
	await page.keyboard.press("Shift+ArrowDown");
	await expect(page.getByText("3 selected")).toBeVisible();
	for (const subject of [e, d, c]) await expect(checkbox(page, subject)).toBeChecked();

	// Shift+Up shrinks it back toward the anchor.
	await page.keyboard.press("Shift+ArrowUp");
	await expect(page.getByText("2 selected")).toBeVisible();
	await expect(checkbox(page, c)).not.toBeChecked();
});
