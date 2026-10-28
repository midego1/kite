import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { E2E_PERSIST_DIR, STORAGE_STATE } from "./support/constants";
import { uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

test.use({ storageState: STORAGE_STATE });

function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	);
}

const TOKEN = uniqueToken()
	.toLowerCase()
	.replace(/[^a-z0-9]/g, "");
const PRICED = `e2e-usage-${TOKEN}-priced`;
const UNRATED = `e2e-usage-${TOKEN}-norate`;
const DAY = 86_400;
// Five days ago at this time of day: inside the 7-day range on a day no other spec writes to (they use today).
const SEEDED_AGO = 5 * DAY;
/** The seeded day in the browser's UTC time zone, as the chart's `data-date`. */
const seededDate = () => new Date(Date.now() - SEEDED_AGO * 1000).toISOString().slice(0, 10);

test.beforeAll(() => {
	const mailbox = "(SELECT id FROM mailboxes WHERE local_part = 'support' ORDER BY created_at LIMIT 1)";
	sql(
		"INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, cost_usd_micros, mailbox_id, job_id, reserved, status, error_code, duration_ms, finish_reason, input_rate, output_rate) VALUES " +
			`('usage_e2e_${TOKEN}_a', unixepoch() - ${SEEDED_AGO}, 'anthropic', '${PRICED}', 'chat', 120000, 30000, 1080000, ${mailbox}, NULL, 0, 'ok', NULL, 2500, 'stop', 4, 20), ` +
			`('usage_e2e_${TOKEN}_b', unixepoch() - ${SEEDED_AGO} + 60, 'custom', '${UNRATED}', 'auto_triage', 50000, 1000, NULL, NULL, 'job_e2e_${TOKEN}', 0, 'failed', 'timeout', 30000, NULL, NULL, NULL), ` +
			`('usage_e2e_${TOKEN}_c', unixepoch() - ${40 * DAY}, 'anthropic', '${PRICED}', 'compose', 7777, 0, 31108, ${mailbox}, NULL, 0, 'ok', NULL, 900, 'stop', 4, 20);`,
	);
});

test.afterAll(() => {
	sql(`DELETE FROM ai_usage WHERE id LIKE 'usage_e2e_${TOKEN}_%'`);
});

async function openUsage(page: Page, range: "7 days" | "30 days" | "90 days" = "7 days") {
	await page.goto("/ai-usage");
	// The first visit compiles the page on the dev server.
	await expect(page.getByRole("heading", { name: "AI Usage", level: 1 })).toBeVisible({ timeout: 60_000 });
	const radio = page.getByRole("radiogroup", { name: "Date range" }).getByRole("radio", { name: range });
	await radio.click();
	await expect(radio).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText(`over the last ${range}`).first()).toBeVisible();
}

const bars = (page: Page) => page.getByRole("group", { name: /per day$/ }).getByRole("button");

test("hovering or focusing a day's bar shows its tokens, requests, cost, failures and models and features", async ({
	page,
}) => {
	await openUsage(page);
	const bar = page.locator(`button[data-date="${seededDate()}"]`);
	const tooltip = page.getByRole("tooltip");

	await bar.hover();
	await expect(tooltip).toBeVisible();
	for (const text of [
		"Total tokens",
		"Input tokens",
		"Output tokens",
		"Requests",
		"Failed",
		"Estimated cost",
		"Requests without a rate",
		"By model",
		PRICED,
		UNRATED,
		"By feature",
		"Assistant chat",
		"Automatic reading",
	])
		await expect(tooltip).toContainText(text);
	await expect(bar).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id")) ?? "");
	// Escape closes a tooltip a pointer opened too.
	await page.keyboard.press("Escape");
	await expect(tooltip).toBeHidden();
	await bar.hover({ position: { x: 2, y: 2 } });
	await expect(tooltip).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(tooltip).toBeHidden();

	// The same details on keyboard focus; arrow keys move between days and Escape closes it.
	await bar.focus();
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText(PRICED);
	await page.keyboard.press("ArrowRight");
	const next = page.locator(`button[data-date="${new Date(Date.now() - 4 * DAY * 1000).toISOString().slice(0, 10)}"]`);
	await expect(next).toBeFocused();
	await expect(tooltip).not.toContainText(UNRATED);
	await page.keyboard.press("ArrowLeft");
	await expect(bar).toBeFocused();
	await expect(tooltip).toContainText(UNRATED);
	await page.keyboard.press("Escape");
	await expect(tooltip).toBeHidden();
	// Only one bar is in the tab order (a roving tab stop).
	await expect(bars(page).and(page.locator('[tabindex="0"]'))).toHaveCount(1);
});

test("the range switch sets the days and the metric switch sets what the bars measure", async ({ page }) => {
	await openUsage(page, "30 days");
	await expect(bars(page)).toHaveCount(30);
	await openUsage(page, "90 days");
	await expect(bars(page)).toHaveCount(90);
	// The 40-day-old request counts in 90 days and not in 7.
	const activity = page.getByRole("region", { name: "AI usage", exact: true });
	await chooseOption(page.getByRole("combobox", { name: "Model" }), PRICED);
	await expect(activity.getByRole("row").filter({ hasText: PRICED })).toHaveCount(2);
	await page.getByRole("radiogroup", { name: "Date range" }).getByRole("radio", { name: "7 days" }).click();
	await expect(bars(page)).toHaveCount(7);
	await expect(activity.getByRole("row").filter({ hasText: PRICED })).toHaveCount(1);

	const metric = page.getByRole("radiogroup", { name: "Chart metric" });
	const bar = page.locator(`button[data-date="${seededDate()}"]`);
	await expect(bar).toHaveAttribute("aria-label", /tokens/);
	await metric.getByRole("radio", { name: "Cost" }).click();
	await expect(metric.getByRole("radio", { name: "Cost" })).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
	await expect(page.getByText("Estimated", { exact: true })).toBeVisible();
	await expect(bar).toHaveAttribute("aria-label", /\$[\d.,]+ estimated cost/);
	await expect(page.getByRole("columnheader", { name: "Share of cost" }).first()).toBeVisible();
	// Arrow keys move the switch too.
	await page.keyboard.press("ArrowRight");
	await expect(metric.getByRole("radio", { name: "Requests" })).toHaveAttribute("aria-checked", "true");
	await expect(metric.getByRole("radio", { name: "Requests" })).toBeFocused();
	await expect(bar).toHaveAttribute("aria-label", /: \d+ requests$/);
	await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
});

test("breakdowns by model, provider, feature and mailbox, outcomes and the models without a rate", async ({ page }) => {
	await openUsage(page);
	const byModel = page.getByRole("region", { name: "By model" });
	const pricedRow = byModel.getByRole("row").filter({ hasText: PRICED });
	await expect(pricedRow).toContainText("150,000");
	await expect(pricedRow).toContainText("$1.08");
	await expect(byModel.getByRole("row").filter({ hasText: UNRATED })).toContainText("1 without rate");
	await expect(page.getByRole("region", { name: "By provider" })).toContainText("Custom API");
	await expect(page.getByRole("region", { name: "By feature" })).toContainText("Automatic reading");
	await expect(page.getByRole("region", { name: "By mailbox" })).toContainText("support@example.com");

	const outcomes = page.getByRole("region", { name: "Outcomes" });
	await expect(outcomes).toContainText("Failed");
	await expect(outcomes).toContainText("Timed out");

	const missing = page.locator("#missing-rates");
	await expect(missing.getByRole("listitem").filter({ hasText: UNRATED })).toContainText("No rate known");
	await expect(page.getByRole("link", { name: /requests have no rate/ })).toHaveAttribute("href", "#missing-rates");

	const spend = page.getByRole("region", { name: "Today's spend and caps" });
	await expect(spend.getByRole("meter", { name: "Install daily spend cap" })).toBeVisible();
	await expect(spend.getByRole("meter", { name: "Chat and writing token allowance" })).toBeVisible();
});

test("activity filters by model, provider, feature and status, and a row opens its details", async ({ page }) => {
	await openUsage(page);
	const activity = page.getByRole("region", { name: "AI usage", exact: true });
	await chooseOption(page.getByRole("combobox", { name: "Status" }), "failed");
	await chooseOption(page.getByRole("combobox", { name: "Model" }), UNRATED);
	await expect(page.getByText("1 request matches the filters.")).toBeVisible();
	const row = activity.getByRole("row").filter({ hasText: UNRATED });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Failed");

	await row.getByRole("button", { name: /Details of the Automatic reading request/ }).click();
	const details = activity.locator("dl");
	await expect(details).toContainText("Automatic reading");
	await expect(details).toContainText("Timed out (timeout)");
	await expect(details).toContainText("30 s");
	await expect(details).toContainText("No rate, so no cost");
	await expect(details).toContainText(`job_e2e_${TOKEN}`);

	// A filter that matches nothing, then provider and feature together.
	await chooseOption(page.getByRole("combobox", { name: "Feature" }), "chat");
	await expect(activity).toContainText("No requests match these filters.");
	await page.getByRole("button", { name: "Clear filters" }).click();
	await chooseOption(page.getByRole("combobox", { name: "Provider" }), "anthropic");
	await chooseOption(page.getByRole("combobox", { name: "Feature" }), "chat");
	await chooseOption(page.getByRole("combobox", { name: "Model" }), PRICED);
	const priced = activity.getByRole("row").filter({ hasText: PRICED });
	await expect(priced).toHaveCount(1);
	await priced.click();
	await expect(activity.locator("dl")).toContainText("$4 in / $20 out per 1M tokens");
	await expect(activity.locator("dl")).toContainText("stop");
	await expect(activity.locator("dl")).toContainText("support@example.com");
	await expect(page.getByText(/Page 1 of 1/)).toBeVisible();
});

test("on a phone the day's details open under the chart instead of over the bars", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openUsage(page);
	const bar = page.locator(`button[data-date="${seededDate()}"]`);
	await bar.focus();
	const tooltip = page.getByRole("tooltip");
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText(PRICED);
	const chart = page.getByRole("group", { name: /per day$/ });
	const [tip, plot] = [await tooltip.boundingBox(), await chart.boundingBox()];
	expect(tip && plot && tip.y >= plot.y + plot.height).toBe(true);
	await page.keyboard.press("Escape");
	await expect(tooltip).toBeHidden();
});
