import { expect, test } from "@playwright/test";
import { chooseOption, expectSelectValue } from "./support/select";

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
		await chooseOption(page.getByRole("combobox", { name: "Calendar view" }), "month");
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
		await expectSelectValue(page.getByRole("combobox", { name: "Calendar view" }), "day");
		await chooseOption(page.getByRole("combobox", { name: "Calendar view" }), "month");
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

test("tentative events carry a Tentative label and dashed border in month, week and the upcoming list", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-01-15T12:00:00Z") });
	const base = {
		description: "",
		location: "",
		attendees: "",
		color: "blue",
		repeat: "none",
		repeatDays: "[]",
		repeatAnchorDay: null,
		repeatUntil: null,
		excludedOccurrences: "[]",
		timeZone: "UTC",
	};
	await page.route("**/api/calendar/events?*", (route) =>
		route.fulfill({
			json: {
				events: [
					{
						...base,
						id: "hold",
						title: "Hold for intro",
						status: "tentative",
						startsAt: "2026-01-16T10:00:00Z",
						endsAt: "2026-01-16T11:00:00Z",
					},
					{
						...base,
						id: "sure",
						title: "Confirmed sync",
						status: "confirmed",
						startsAt: "2026-01-16T13:00:00Z",
						endsAt: "2026-01-16T14:00:00Z",
					},
				],
			},
		}),
	);
	await page.goto("/calendar");
	const upcoming = page.locator('[data-status="tentative"]');
	await expect(upcoming.filter({ hasText: "Hold for intro" }).first()).toContainText("Tentative");
	await expect(page.getByRole("button", { name: /Confirmed sync/ }).first()).not.toHaveAttribute(
		"data-status",
		"tentative",
	);
	const week = page.locator('button[data-status="tentative"][title*="Hold for intro"]');
	await expect(week).toHaveClass(/border-dashed/);
	await expect(week).toContainText("Tentative");
	await chooseOption(page.getByRole("combobox", { name: "Calendar view" }), "month");
	const month = page.locator('[aria-label="Monthly calendar"]');
	const chip = month.locator('button[data-status="tentative"]');
	await expect(chip).toHaveCount(1);
	await expect(chip).toHaveClass(/border-dashed/);
	await expect(chip).toContainText("Tentative");
	await expect(month.getByRole("button", { name: /Confirmed sync/ })).not.toHaveClass(/border-dashed/);
});
