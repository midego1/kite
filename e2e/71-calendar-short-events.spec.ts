import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });
// A narrow window keeps the week columns around 100px, where a one-line event has little room.
test.use({ viewport: { width: 820, height: 900 } });

const event = (id: string, title: string, startsAt: string, endsAt: string, status = "confirmed") => ({
	id,
	title,
	description: "",
	startsAt,
	endsAt,
	location: "",
	attendees: "",
	color: "blue",
	status,
	repeat: "none",
	repeatDays: "[]",
	repeatAnchorDay: null,
	repeatUntil: null,
	excludedOccurrences: "[]",
	timeZone: "UTC",
});

const EVENTS = [
	event("hour", "Typography gypsy jury", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
	event("tentative-hour", "Tentative jury gypsy", "2026-01-15T11:30:00Z", "2026-01-15T12:30:00Z", "tentative"),
	event("half", "Typography gypsy jury", "2026-01-15T13:00:00Z", "2026-01-15T13:30:00Z"),
	event("tentative-half", "Tentative gypsy jury", "2026-01-15T14:00:00Z", "2026-01-15T14:30:00Z", "tentative"),
	event("forty-five", "Typography gypsy jury", "2026-01-15T15:00:00Z", "2026-01-15T15:45:00Z"),
	event("quarter", "Quick sync", "2026-01-15T16:00:00Z", "2026-01-15T16:15:00Z"),
	event("long", "Planning day", "2026-01-15T17:00:00Z", "2026-01-15T20:00:00Z"),
	event("night", "Night shift", "2026-01-14T23:00:00Z", "2026-01-15T00:30:00Z"),
];

test("short events keep their text inside the block and the title readable", async ({ page }, testInfo) => {
	await page.addInitScript(() => localStorage.setItem("kite-theme", "light"));
	await page.clock.install({ time: new Date("2026-01-15T08:00:00Z") });
	await page.route("**/api/calendar/events?*", (route) => route.fulfill({ json: { events: EVENTS } }));
	await page.goto("/calendar?date=2026-01-15");

	const block = (title: string) => page.locator(`button[title^='${title}']`).last();
	await expect(block("Typography gypsy jury · 10 AM")).toBeVisible();

	// What the block really draws: its size, whether a border takes room, and each line of text.
	const measure = (title: string) =>
		block(title).evaluate((button) => {
			const box = button.getBoundingClientRect();
			const style = getComputedStyle(button);
			const lines = [...button.querySelectorAll<HTMLElement>(":scope > span:not([class*='absolute'])")];
			return {
				height: box.height,
				width: box.width,
				border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
				overflow: button.scrollHeight - button.clientHeight,
				lines: lines.map((line) => {
					const rect = line.getBoundingClientRect();
					return {
						inside: rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5,
						clipped: line.scrollHeight > line.clientHeight,
						width: rect.width,
						text: line.textContent ?? "",
					};
				}),
			};
		});

	for (const [title, height, count] of [
		["Typography gypsy jury · 10 AM", 36, 2],
		["Tentative jury gypsy · 11:30 AM", 36, 2],
		["Typography gypsy jury · 1 PM", 18, 1],
		["Tentative gypsy jury · 2 PM", 18, 1],
		["Typography gypsy jury · 3 PM", 27, 1],
		["Planning day", 108, 2],
	] as const) {
		const fit = await measure(title);
		expect(fit.height, title).toBeCloseTo(height, 0);
		expect(fit.border, `${title}: a border would take room from the text`).toBe(0);
		expect(fit.overflow, title).toBeLessThanOrEqual(0);
		expect(fit.lines, title).toHaveLength(count);
		for (const line of fit.lines) {
			expect(line.inside, `${title}: "${line.text}" sits inside the block`).toBe(true);
			expect(line.clipped, `${title}: "${line.text}" is not cut vertically`).toBe(false);
		}
		// The line has room for the title itself, not only a time.
		expect(fit.lines[0]!.width, `${title}: the title keeps visible width`).toBeGreaterThan(40);
	}

	// The column is narrow enough that the one-line events are cut, and what stays is the start of the line.
	const half = await measure("Typography gypsy jury · 1 PM");
	expect(half.width).toBeLessThan(130);
	await expect(block("Typography gypsy jury · 1 PM")).toContainText("Typography");

	// Tentative stays visible in the one-line layout: italic, with the word for screen readers.
	const tentative = block("Tentative gypsy jury · 2 PM");
	await expect(tentative.locator(":scope > span:not([class*='absolute'])")).toHaveCSS("font-style", "italic");
	await expect(tentative).toContainText("Tentative");

	// A quarter-hour block is too short for any text, so it draws none instead of a cut line.
	expect((await measure("Quick sync")).lines).toHaveLength(0);

	// The piece after midnight cannot show the start of the day before.
	await expect(block("Night shift")).toContainText("Night shift, until 12:30 AM");

	await page.screenshot({ path: testInfo.outputPath("calendar-short-events.png") });
});
