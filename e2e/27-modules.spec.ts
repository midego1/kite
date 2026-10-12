import { expect, test } from "@playwright/test";

test("the session answer lists the four modules that are on for the owner", async ({ request }) => {
	const response = await request.get("/api/auth/me");
	expect(response.status()).toBe(200);
	const body = await response.json();
	expect(body.modules).toEqual(["calendar", "booking", "templates", "import"]);
});

test("the mailbox and the calendar both load with every module on", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	await page.goto("/calendar");
	await expect(page).toHaveURL(/\/calendar/);
	await expect(page.getByText("Page not found")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
});
