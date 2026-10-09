import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });

for (const variant of [
	{ name: "kite", style: "kite", theme: "light" },
	{ name: "classic", style: "classic", theme: "light" },
	{ name: "dark", style: "kite", theme: "dark" },
]) {
	test(`month view handles recurrence and navigation in ${variant.name}`, async ({ page }, testInfo) => {
		await page.addInitScript(({ style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		}, variant);
		await page.clock.install({ time: new Date("2026-01-15T12:00:00Z") });
		const requested: URL[] = [];
		await page.route("**/api/calendar/events?*", (route) => {
			requested.push(new URL(route.request().url()));
			return route.fulfill({
				json: {
					events: [
						{
							id: "monthly",
							title: "Month-end review",
							description: "",
							startsAt: "2026-01-31T12:00:00Z",
							endsAt: "2026-01-31T13:00:00Z",
							location: "",
							attendees: "",
							color: "blue",
							repeat: "monthly",
							repeatDays: "[]",
							repeatAnchorDay: 31,
							repeatUntil: null,
							excludedOccurrences: "[]",
							timeZone: "UTC",
						},
						{
							id: "june",
							title: "June planning",
							description: "",
							startsAt: "2026-06-30T12:00:00Z",
							endsAt: "2026-06-30T13:00:00Z",
							location: "",
							attendees: "",
							color: "blue",
							repeat: "none",
							repeatDays: "[]",
							repeatAnchorDay: null,
							repeatUntil: null,
							excludedOccurrences: "[]",
							timeZone: "UTC",
						},
					],
				},
			});
		});
		await page.goto("/calendar");
		await page.getByRole("combobox", { name: "Calendar view" }).selectOption("month");
		const month = page.locator('[aria-label="Monthly calendar"]');
		await expect(month.getByRole("button", { name: "Show day 2026-01-31", exact: true })).toBeVisible();
		await expect(month.getByRole("button", { name: /Month-end review/ })).toBeVisible();
		await page.getByRole("button", { name: "Next month", exact: true }).click();
		const february = month.getByRole("region", { name: "Saturday, February 28, 2026" });
		await expect(february.getByRole("button", { name: /Month-end review/ })).toBeVisible();
		await page.getByRole("button", { name: "Previous month", exact: true }).click();
		for (let index = 0; index < 5; index++) await page.getByRole("button", { name: "Next month", exact: true }).click();
		await expect(month.getByRole("button", { name: /June planning/ })).toBeVisible();
		expect(requested.some((url) => new Date(url.searchParams.get("end")!) > new Date("2026-07-01T00:00:00Z"))).toBe(
			true,
		);
		await page.screenshot({ path: testInfo.outputPath("calendar-month.png") });
		await month.getByRole("button", { name: /June planning/ }).click();
		await expect(page.getByRole("dialog", { name: "Edit event" }).getByLabel("Event name")).toHaveValue(
			"June planning",
		);
		await page.getByRole("button", { name: "Close event editor" }).click();
		await month.getByRole("button", { name: "Show day 2026-06-30", exact: true }).click();
		await expect(page.getByRole("combobox", { name: "Calendar view" })).toHaveValue("day");
		await page.getByRole("combobox", { name: "Calendar view" }).selectOption("month");
		await month.getByRole("button", { name: "Add event on 2026-06-30", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Create event" })).toBeVisible();
	});
}

test("month view is available from the mobile calendar menu", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/calendar");
	await page.getByRole("button", { name: "Calendar options" }).click();
	await page.getByRole("menuitem", { name: "month", exact: true }).click();
	await expect(page.locator('[aria-label="Monthly calendar"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Next month", exact: true })).toBeVisible();
});
