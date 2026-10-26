import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings } from "./support/helpers";
import { chooseOption, expectSelectValue } from "./support/select";

test.afterEach(async () => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	await api.dispose();
});

test("sending settings are saved to the account and survive a reload", async ({ page }) => {
	await page.goto("/settings/inbox");
	const preview = page.getByRole("switch", { name: "Preview before sending" });
	const undoWindow = page.getByRole("combobox", { name: "Undo send window" });
	await expect(preview).toHaveAttribute("aria-checked", "false");
	await expectSelectValue(undoWindow, "0");

	const waitForSave = () =>
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/settings/sending") && response.request().method() === "PATCH" && response.ok(),
		);
	let saved = waitForSave();
	await preview.click();
	await saved;
	saved = waitForSave();
	await chooseOption(undoWindow, { label: "20 seconds" });
	await saved;

	await page.reload();
	await expect(page.getByRole("switch", { name: "Preview before sending" })).toHaveAttribute("aria-checked", "true");
	await expectSelectValue(page.getByRole("combobox", { name: "Undo send window" }), "20");

	// Stored per account, so a different browser profile sees it too.
	const api = await apiContext(STORAGE_STATE);
	const stored = await (await api.get("/api/settings/sending")).json();
	expect(stored).toMatchObject({ previewEnabled: true, undoSeconds: 20 });
	await api.dispose();
});

test("typing into a closed dropdown picks an option and does not run keyboard shortcuts", async ({ page }) => {
	await page.goto("/settings/appearance");
	const style = page.getByRole("combobox", { name: "Style" });
	await expectSelectValue(style, "kite");
	// Shortcuts bind once the account's preference has loaded; the help sheet opening shows they are live.
	const help = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
	await expect(async () => {
		if (!(await help.isVisible())) await page.keyboard.press("?");
		await expect(help).toBeVisible({ timeout: 1000 });
	}).toPass();
	await page.keyboard.press("Escape");
	await expect(help).toHaveCount(0);

	await style.focus();
	// `c` is also the Compose shortcut; like a native select, the dropdown keeps the key to itself.
	await page.keyboard.press("c");
	await expectSelectValue(style, "classic");
	// The composer loads its form on demand, so give a wrongly fired shortcut time to show it.
	await page.waitForTimeout(1500);
	await expect(page.getByRole("button", { name: "Close composer" })).toHaveCount(0);
	await chooseOption(style, { label: "Kite" });
	await expectSelectValue(style, "kite");
});

test("a required dropdown left empty fails validation and hands the focus to its trigger", async ({ page }) => {
	await page.goto("/accounts");
	await page.getByRole("button", { name: "New account" }).click();
	const dialog = page.getByRole("dialog", { name: "Add user account" });
	const domain = dialog.getByRole("combobox", { name: "Domain" });
	await chooseOption(domain, { label: "Select domain" });
	await expectSelectValue(domain, "");
	// The hidden native select carries `required` for the form but is never a tab stop of its own.
	const formControl = dialog.locator('select[aria-hidden="true"][required]');
	await expect(formControl).toHaveAttribute("tabindex", "-1");
	await page.keyboard.press("Tab");
	await expect(formControl).not.toBeFocused();
	// Validation focuses the invalid control, which hands the focus to the dropdown people can use.
	expect(await formControl.evaluate((element) => (element as unknown as HTMLSelectElement).reportValidity())).toBe(
		false,
	);
	await expect(domain).toBeFocused();
});

test.describe("assistant step limit", () => {
	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await api.patch("/api/settings/assistant", { data: { maxSteps: 15 } });
		await api.dispose();
	});

	test("is stored per account and validated", async () => {
		const api = await apiContext(STORAGE_STATE);
		expect(await (await api.get("/api/settings/assistant")).json()).toMatchObject({
			maxSteps: 15,
			minSteps: 3,
			maxAllowedSteps: 30,
		});
		for (const maxSteps of [2, 31, 4.5])
			expect((await api.patch("/api/settings/assistant", { data: { maxSteps } })).status()).toBe(400);
		const updated = await api.patch("/api/settings/assistant", { data: { maxSteps: 22 } });
		expect(updated.ok(), await updated.text()).toBe(true);
		expect(await (await api.get("/api/settings/assistant")).json()).toMatchObject({ maxSteps: 22 });
		await api.dispose();

		const anonymous = await apiContext();
		expect((await anonymous.get("/api/settings/assistant")).status()).toBe(401);
		await anonymous.dispose();
	});

	test("is editable in the assistant settings and survives a reload", async ({ page }) => {
		await page.goto("/inbox");
		const assistant = page.getByRole("button", { name: "Open email assistant" });
		await page.waitForLoadState("networkidle");
		test.skip((await assistant.count()) === 0, "The assistant is not enabled in this environment.");

		// The assistant's open state is remembered, so after a reload it may already be open.
		const openSettings = async () => {
			const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
			await expect(toggle).toBeVisible();
			if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click();
			await page.getByRole("button", { name: "Assistant settings" }).click();
			return page.getByRole("spinbutton", { name: "Max steps per question" });
		};
		const input = await openSettings();
		await expect(page.getByRole("button", { name: "Assistant settings" })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
		await expect(page.getByLabel("Previous chats")).toBeVisible();
		await expect(input).toHaveValue("15");
		await expect(page.getByText("Each tool call counts as a step.")).toBeVisible();
		await input.fill("9");
		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/settings/assistant") && response.request().method() === "PATCH" && response.ok(),
		);
		await page.getByRole("button", { name: "Save step limit" }).click();
		await saved;

		await page.reload();
		await expect(await openSettings()).toHaveValue("9");
	});
});

test.describe("assistant display", () => {
	let assistantWasEnabled = false;
	test.beforeEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		assistantWasEnabled = ((await (await api.get("/api/admin/agent")).json()) as { assistantEnabled: boolean })
			.assistantEnabled;
		expect((await api.put("/api/admin/agent", { data: { enabled: true } })).ok()).toBe(true);
		await api.dispose();
	});
	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await api.put("/api/admin/agent", { data: { enabled: assistantWasEnabled } });
		await api.dispose();
	});

	const openAssistant = async (page: import("@playwright/test").Page) => {
		const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click();
		await expect(page.locator("#email-assistant-panel")).toBeVisible();
	};

	test("output settings are shared between the assistant and Appearance and survive a reload", async ({ page }) => {
		await page.goto("/inbox");
		await openAssistant(page);
		await page.getByRole("button", { name: "Assistant settings" }).click();
		const panel = page.locator("#email-assistant-panel");
		await expectSelectValue(panel.getByRole("combobox", { name: "Assistant steps" }), "live");
		const stepsRow = panel.getByRole("combobox", { name: "Assistant steps" }).locator("..").locator("..");
		expect((await stepsRow.boundingBox())!.height).toBeLessThan(80);
		await expect(panel.getByText(/Steps can appear live/)).toBeHidden();
		await panel.getByText("Display help", { exact: true }).click();
		await expect(panel.getByText(/Steps can appear live/)).toBeVisible();
		await expectSelectValue(panel.getByRole("combobox", { name: "Step details" }), "emails");
		await chooseOption(panel.getByRole("combobox", { name: "Assistant steps" }), { label: "Hidden" });
		await chooseOption(panel.getByRole("combobox", { name: "Step details" }), { label: "Everything" });

		await page.goto("/settings/appearance");
		await expectSelectValue(page.getByRole("combobox", { name: "Assistant steps" }), "hidden");
		await expectSelectValue(page.getByRole("combobox", { name: "Step details" }), "full");
		await chooseOption(page.getByRole("combobox", { name: "Assistant steps" }), { label: "Collapsed" });
		await page.reload();
		await expectSelectValue(page.getByRole("combobox", { name: "Assistant steps" }), "collapsed");
		await expectSelectValue(page.getByRole("combobox", { name: "Step details" }), "full");
	});

	test("the chat window opens from the Ask Kite AI bubble, which steps aside for the composer", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await page.goto("/inbox");
		const header = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
		await expect(header).toBeVisible();
		if ((await header.getAttribute("aria-label")) === "Close email assistant") await header.click();
		const panel = page.locator("#email-assistant-panel");
		await expect(panel).toBeHidden();

		const bubble = page.getByRole("button", { name: "Ask Kite AI" });
		await expect(bubble).toHaveAttribute("aria-expanded", "false");
		await bubble.click();
		await expect(panel).toBeVisible();
		const minimize = page.getByRole("button", { name: "Minimize Kite AI" });
		await expect(minimize).toHaveAttribute("aria-expanded", "true");
		// The window floats above the bubble instead of covering it.
		const windowBox = (await panel.boundingBox())!;
		const bubbleBox = (await minimize.boundingBox())!;
		expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(bubbleBox.y);

		await minimize.click();
		await expect(panel).toBeHidden();
		await page.getByRole("button", { name: "Compose" }).click();
		await expect(page.getByLabel("Subject")).toBeVisible();
		await expect(bubble).toBeHidden();
		await page.getByRole("button", { name: "Close composer" }).click();
		await expect(bubble).toBeVisible();
	});

	test("the chat window can be resized from its edges and keeps its size", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await page.goto("/inbox");
		await openAssistant(page);
		const panel = page.locator("#email-assistant-panel");
		const before = (await panel.boundingBox())!;

		const drag = async (name: string, dx: number, dy: number) => {
			const box = (await page.getByRole("separator", { name }).boundingBox())!;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.down();
			await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
			await page.mouse.up();
		};
		await drag("Resize assistant width", -120, 0);
		await drag("Resize assistant height", 0, -60);
		const after = (await panel.boundingBox())!;
		expect(Math.round(after.width - before.width)).toBe(120);
		expect(Math.round(after.height - before.height)).toBe(60);

		await page.reload();
		await openAssistant(page);
		const reloaded = (await panel.boundingBox())!;
		expect(Math.round(reloaded.width)).toBe(Math.round(after.width));
		expect(Math.round(reloaded.height)).toBe(Math.round(after.height));
	});
});
