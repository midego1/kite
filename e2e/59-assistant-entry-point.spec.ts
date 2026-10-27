import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Where people find Kite AI: a button in the list header and the reader toolbar, the "." key, and the
// floating bubble, which only a floating composer hides.

async function mockAssistant(page: Page) {
	await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: true } }));
	await page.route("**/api/agent/settings?*", (route) =>
		route.fulfill({
			json: {
				settings: {
					mailboxId: "demo",
					enabled: true,
					modelId: "demo",
					autoDraftEnabled: false,
					reviewerUserId: null,
					instructions: "",
					dailyLimit: 5,
				},
				models: ["demo"],
				canManage: true,
				providerConfigured: true,
				autoReplyEnabled: false,
				reviewers: [],
			},
		}),
	);
	await page.route("**/api/agent/jobs?*", (route) => route.fulfill({ json: { jobs: [] } }));
	await page.route("**/api/agent/conversations?*", (route) => route.fulfill({ json: { conversations: [] } }));
}

async function openMessage(page: Page): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Entry point ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Entry Sender" <entry@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Body of the entry point message.",
	});
	await api.dispose();
	await page.goto("/inbox");
	await page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link")
		.click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	return subject;
}

test.describe("Kite AI entry points", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await mockAssistant(page);
	});

	test("the reader toolbar button opens and closes the assistant", async ({ page }) => {
		await openMessage(page);
		const reader = page.getByTestId("assistant-button-reader");
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(reader).toHaveAccessibleName("Open Kite AI");
		await expect(reader).toHaveAttribute("aria-expanded", "false");
		await expect(reader).toHaveAttribute("aria-controls", "email-assistant-panel");

		await reader.click();
		await expect(panel).toBeVisible();
		await expect(reader).toHaveAccessibleName("Close Kite AI");
		await expect(reader).toHaveAttribute("aria-expanded", "true");

		await reader.click();
		await expect(panel).toBeHidden();
		await expect(reader).toHaveAttribute("aria-expanded", "false");
	});

	test("the list header button opens and closes the assistant", async ({ page }) => {
		await page.goto("/inbox");
		const list = page.getByTestId("assistant-button-list");
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(list).toBeVisible();
		if ((await list.getAttribute("aria-expanded")) === "true") await list.click();
		await expect(panel).toBeHidden();

		await list.click();
		await expect(panel).toBeVisible();
		await expect(list).toHaveAttribute("aria-expanded", "true");
		await list.click();
		await expect(panel).toBeHidden();
		await expect(list).toHaveAttribute("aria-expanded", "false");
	});

	test("the . key toggles Kite AI, and the palette and the cheat sheet list it", async ({ page }) => {
		await page.goto("/inbox");
		const panel = page.getByRole("region", { name: "Email assistant" });
		const toggle = page.getByTestId("assistant-button-list");
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
		await expect(panel).toBeHidden();

		// The keys bind once the shortcut preference has loaded, which is when the cheat sheet can open.
		const sheet = page.getByRole("dialog");
		await expect(async () => {
			await page.keyboard.press("?");
			await expect(sheet).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await expect(sheet.getByText("Toggle Kite AI")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();

		await page.locator("body").press(".");
		await expect(panel).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await page.locator("body").press(".");
		await expect(panel).toBeHidden();

		await page.keyboard.press("ControlOrMeta+k");
		await page.getByPlaceholder("Type a command or search actions...").fill("Open Kite AI");
		await page.getByRole("option", { name: /Open Kite AI/ }).click();
		await expect(panel).toBeVisible();
	});

	test("the entry points stay hidden while the assistant is off", async ({ page }) => {
		await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: false } }));
		await page.addInitScript(() => localStorage.setItem("kite-assistant-enabled", "false"));
		await openMessage(page);
		await expect(page.getByTestId("assistant-button-reader")).toHaveCount(0);
		await expect(page.getByTestId("assistant-button-list")).toHaveCount(0);
		await page.locator("body").press(".");
		await expect(page.getByRole("region", { name: "Email assistant" })).toBeHidden();
	});

	test("the Ask Kite AI bubble stays with a reply docked in the reader and steps aside for the floating composer", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await openMessage(page);
		const bubble = page.getByRole("button", { name: "Ask Kite AI" });
		await expect(bubble).toBeVisible();

		await page.getByRole("button", { name: /^Reply to Entry Sender/ }).click();
		await expect(
			page
				.getByRole("main")
				.getByRole("region", { name: "Compose message" })
				.filter({ has: page.getByRole("button", { name: "Pop out composer" }) }),
		).toBeVisible();
		await expect(bubble).toBeVisible();
		// The docked reply's footer runs under the corner, so the bubble must not cover its buttons.
		const bubbleBox = await bubble.boundingBox();
		const deleteBox = await page.getByRole("button", { name: "Delete draft" }).boundingBox();
		expect(bubbleBox && deleteBox).toBeTruthy();
		expect(bubbleBox!.y + bubbleBox!.height <= deleteBox!.y || deleteBox!.x + deleteBox!.width <= bubbleBox!.x).toBe(
			true,
		);

		await page.getByRole("button", { name: "Pop out composer" }).click();
		await expect(page.getByRole("button", { name: "Minimize composer" })).toBeVisible();
		await expect(bubble).toBeHidden();
	});
});
