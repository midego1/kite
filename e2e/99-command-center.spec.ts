import { expect, test, type Page } from "@playwright/test";
import { ADMIN } from "./support/constants";

// The empty reading pane's command center (src/components/command-center/): a greeting with the date, the
// counts, the connected accounts, what needs attention (admins) and quick actions. The database notice keeps its
// place inside the pane (19-updates covers Apply now and its progress).

const PENDING_API = "/api/migrations/pending";

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

function pane(page: Page) {
	return page.getByTestId("reading-pane-empty");
}

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(pane(page)).toBeVisible();
}

/** Answers the session as a member: the same account, without the admin role. */
async function asMember(page: Page) {
	await page.route("**/api/auth/me", async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { user: Record<string, unknown> };
		body.user = { ...body.user, role: "user", isPrimaryAdmin: false };
		await route.fulfill({ response, json: body });
	});
}

test("the pane greets the account, counts the mail and still says what to do", async ({ page }) => {
	await openInbox(page);
	const center = pane(page);
	await expect(center.getByRole("heading", { level: 2 })).toContainText(ADMIN.name);
	await expect(center.getByRole("heading", { level: 2 })).toContainText(/Good (night|morning|afternoon|evening)/);
	// Today's date, in the test's UTC zone, as the pane spells it: weekday, day, month, year.
	const parts = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).formatToParts(new Date());
	const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
	const today = `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
	await expect(center.getByText(today)).toBeVisible();
	await expect(center.locator("[data-chip=unread]")).toHaveText(/^\d+ unread in Inbox$/);
	await expect(center.locator("[data-chip=unread]")).toHaveAttribute("href", "/inbox");
	await expect(center.getByText(/Select a message to read/)).toBeVisible();
	await expect(center.locator("[data-command-center-kite]")).toBeAttached();
	// The admin sees the attention card with a link to the admin overview.
	const attention = center.getByTestId("command-center-attention");
	await expect(attention).toBeVisible();
	await expect(attention.getByRole("link", { name: "Admin overview" })).toHaveAttribute("href", "/admin");
});

test("quick actions open the composer and focus the search", async ({ page }) => {
	await openInbox(page);
	const center = pane(page);
	await center.locator("[data-quick-action=compose]").click();
	await expect(page.getByLabel("To", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Close composer" }).click();
	await expect(page.getByLabel("To", { exact: true })).toHaveCount(0);

	await center.locator("[data-quick-action=search]").click();
	await expect(page.locator('input[placeholder*="Search"]')).toBeFocused();
});

test("waiting database updates stay in the notice with Apply now, not twice in the list", async ({ page }) => {
	await page.route(`**${PENDING_API}`, (route) =>
		route.fulfill({ json: { pending: 1, names: ["0001_add_column.sql"] } }),
	);
	await openInbox(page);
	const center = pane(page);
	const notice = center.getByRole("region", { name: "Database updates" });
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("Kite was updated, but the database still needs 1 update");
	await expect(notice.getByRole("button", { name: "Apply now" })).toBeVisible();
	await expect(center.getByTestId("command-center-attention")).toBeVisible();
	await expect(center.getByTestId("command-center-attention-migrations")).toHaveCount(0);
});

test("a member gets the greeting and the counts but no admin card, and cannot apply updates", async ({ page }) => {
	await asMember(page);
	await page.route(`**${PENDING_API}`, (route) => route.fulfill({ json: { pending: 1 } }));
	await openInbox(page);
	const center = pane(page);
	await expect(center.getByRole("heading", { level: 2 })).toContainText(ADMIN.name);
	await expect(center.locator("[data-chip=unread]")).toBeVisible();
	await expect(center.getByTestId("command-center-attention")).toHaveCount(0);
	const notice = center.getByRole("region", { name: "Database updates" });
	await expect(notice).toBeVisible();
	await expect(notice.getByRole("button", { name: "Apply now" })).toHaveCount(0);
});

test("connected accounts are listed with their state, failures first with a way to fix them", async ({ page }) => {
	const synced = new Date(Date.now() - 3 * 60_000).toISOString();
	await page.route("**/api/external-accounts", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await route.fulfill({
			json: {
				accounts: [
					{
						id: "icloud",
						label: "iCloud",
						address: "jamie@icloud.example",
						status: "active",
						sync: { running: false, lastSuccessAt: synced },
					},
					{
						id: "gmail",
						label: "Gmail",
						address: "jamie@gmail.example",
						status: "auth_failed",
						sync: { running: false, lastSuccessAt: null },
					},
				],
				refusal: null,
				refusalText: null,
				presets: [],
				migrationPending: false,
			},
		});
	});
	await openInbox(page);
	const accounts = pane(page).getByTestId("command-center-accounts");
	await expect(accounts).toBeVisible();
	const lines = accounts.getByRole("listitem");
	await expect(lines).toHaveCount(2);
	await expect(lines.nth(0)).toHaveAttribute("data-account-status", "warn");
	await expect(lines.nth(0)).toContainText("Gmail");
	await expect(lines.nth(0).getByRole("link", { name: "Reconnect" })).toHaveAttribute(
		"href",
		"/settings/connected-accounts",
	);
	await expect(lines.nth(1)).toHaveAttribute("data-account-status", "ok");
	await expect(lines.nth(1)).toContainText("iCloud");
	await expect(lines.nth(1)).toContainText("Synced 3 min ago");
	await expect(accounts.getByRole("link", { name: "Connected accounts" })).toHaveAttribute(
		"href",
		"/settings/connected-accounts",
	);
});

test("without connected accounts the card offers to connect one, or hides when that is not allowed", async ({
	page,
}) => {
	await page.route("**/api/external-accounts", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await route.fulfill({
			json: { accounts: [], refusal: null, refusalText: null, presets: [], migrationPending: false },
		});
	});
	await openInbox(page);
	await expect(pane(page).getByTestId("command-center-accounts")).toContainText(
		"Connect Gmail, iCloud or another account",
	);

	await page.unrouteAll({ behavior: "ignoreErrors" });
	await page.route("**/api/external-accounts", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await route.fulfill({
			json: { accounts: [], refusal: "install_off", refusalText: "Off", presets: [], migrationPending: false },
		});
	});
	await openInbox(page);
	await expect(pane(page).getByRole("heading", { level: 2 })).toBeVisible();
	await expect(pane(page).getByTestId("command-center-accounts")).toHaveCount(0);
});
