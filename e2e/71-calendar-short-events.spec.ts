import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });

const event = (id: string, title: string, startsAt: string, endsAt: string) => ({
	id,
	title,
	description: "",
	startsAt,
	endsAt,
	location: "",
	attendees: "",
	color: "blue",
	repeat: "none",
	repeatDays: "[]",
	repeatAnchorDay: null,
	repeatUntil: null,
	excludedOccurrences: "[]",
	timeZone: "UTC",
});

for (const variant of [
	{ name: "light", theme: "light" },
	{ name: "dark", theme: "dark" },
]) {
	test(`short events keep their text inside the block in ${variant.name}`, async ({ page }, testInfo) => {
		await page.addInitScript((theme) => localStorage.setItem("kite-theme", theme), variant.theme);
		await page.clock.install({ time: new Date("2026-01-15T08:00:00Z") });
		await page.route("**/api/calendar/events?*", (route) =>
			route.fulfill({
				json: {
					events: [
						event("hour", "Typography gypsy jury", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
						event("half", "Typography gypsy jury", "2026-01-15T12:00:00Z", "2026-01-15T12:30:00Z"),
						event("quarter", "Quick sync", "2026-01-15T14:00:00Z", "2026-01-15T14:15:00Z"),
						event("long", "Planning day", "2026-01-15T15:00:00Z", "2026-01-15T18:00:00Z"),
					],
				},
			}),
		);
		await page.goto("/calendar?date=2026-01-15");

		const block = (id: string) => page.locator("button[title^='" + id + "']");
		const hour = block("Typography gypsy jury · 10");
		await expect(hour).toBeVisible();

		// Every line of text sits inside its block with no vertical overflow to clip a descender.
		const fits = (locator: ReturnType<typeof block>) =>
			locator.evaluate((button) => {
				const box = button.getBoundingClientRect();
				const spans = [...button.querySelectorAll<HTMLElement>(":scope > span:not([class*='absolute'])")];
				return {
					overflow: button.scrollHeight - button.clientHeight,
					lines: spans.length,
					inside: spans.every((span) => {
						const rect = span.getBoundingClientRect();
						return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
					}),
				};
			});

		const hourFit = await fits(hour);
		expect(hourFit.lines).toBe(2);
		expect(hourFit.overflow).toBeLessThanOrEqual(0);
		expect(hourFit.inside).toBe(true);
		await expect(hour).toContainText("Typography gypsy jury");
		await expect(hour).toContainText("10 AM – 11 AM");

		const half = block("Typography gypsy jury · 12");
		const halfFit = await fits(half);
		expect(halfFit.lines).toBe(1);
		expect(halfFit.overflow).toBeLessThanOrEqual(0);
		expect(halfFit.inside).toBe(true);
		await expect(half).toContainText("Typography gypsy jury, 12 PM");

		// A quarter-hour block is too short for any text, so it draws none instead of a cut line.
		const quarter = block("Quick sync");
		expect((await fits(quarter)).lines).toBe(0);

		const long = await fits(block("Planning day"));
		expect(long.lines).toBe(2);
		expect(long.inside).toBe(true);

		await page.screenshot({ path: testInfo.outputPath(`calendar-short-events-${variant.name}.png`) });
	});
}
