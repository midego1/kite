import { expect, test } from "@playwright/test";

test("finds a seeded message by its subject", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("main").getByText("Cannot access workspace", { exact: true }).first()).toBeVisible();

	const search = page.getByRole("textbox", { name: /Search mail/ });
	await search.fill("Webhook retry question");
	await search.press("Enter");

	const main = page.getByRole("main");
	// Searching narrows the current folder, so the other inbox message drops out.
	await expect(main.getByText("Cannot access workspace", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Webhook retry question", { exact: true }).first()).toBeVisible();
});

for (const { path, field } of [
	{ path: "/inbox", field: { role: "textbox", name: /Search mail/ } },
	{ path: "/settings/account", field: { role: "combobox", name: "Search settings" } },
] as const) {
	test(`the focused search ring is drawn inside the pill on ${path}`, async ({ page }) => {
		await page.goto(path);
		const search = page.getByRole(field.role, { name: field.name });
		await search.focus();
		// An outset ring is clipped by the overflow-hidden content column next to the sidebar.
		const pill = search.locator("xpath=..");
		await expect.poll(() => pill.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("inset");
	});
}

test("shows no results for a query nothing matches", async ({ page }) => {
	await page.goto("/inbox");
	const search = page.getByRole("textbox", { name: /Search mail/ });
	await search.fill("zzqqnomatchzzqq");
	await search.press("Enter");
	const main = page.getByRole("main");
	await expect(main.getByText("No messages match these filters")).toBeVisible();
	await expect(main.getByText("Cannot access workspace", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Webhook retry question", { exact: true })).toHaveCount(0);
});
