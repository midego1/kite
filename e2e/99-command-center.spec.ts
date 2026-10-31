import { expect, test, type Page } from "@playwright/test";
import { createSignedInAccount, okJson } from "./support/auto-read";
import { ADMIN, BASE_URL, STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";

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

test("Calendar and Money Watch add their cards, which leave when the module is off for the user or the install", async ({
	browser,
}) => {
	const owner = await apiContext(STORAGE_STATE);
	// A new account, so the cards list only what this test made.
	const member = await createSignedInAccount(owner, `cc${uniqueToken("")}`);
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await member.api.storageState() });
	try {
		const title = `Standup ${uniqueToken("")}`;
		const now = Date.now();
		await okJson(
			await member.api.post("/api/calendar/events", {
				data: {
					title,
					location: "Room 4",
					startsAt: new Date(now - 60_000).toISOString(),
					endsAt: new Date(now + 30 * 60_000).toISOString(),
				},
			}),
		);
		const vendor = `Northwind ${uniqueToken("").slice(-6)}`;
		const { subscription } = await okJson<{ subscription: { id: string } }>(
			await member.api.post("/api/finance/subscriptions", {
				data: {
					vendor,
					amountMinor: 1200,
					currency: "EUR",
					cycle: "monthly",
					nextRenewalOn: new Date(now + 2 * 86_400_000).toISOString().slice(0, 10),
					reminderDays: 3,
					mailboxId: member.mailboxId,
				},
			}),
		);

		const page = await context.newPage();
		await openInbox(page);
		const center = pane(page);
		const today = center.getByTestId("command-center-today");
		const renewals = center.getByTestId("command-center-renewals");
		const showsBoth = async () => {
			const event = today.getByRole("link", { name: new RegExp(title) });
			await expect(event).toContainText("Now");
			await expect(event).toContainText("Room 4");
			await expect(event).toHaveAttribute("href", /^\/calendar\?date=\d{4}-\d{2}-\d{2}&event=evt_/);
			await expect(today.getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute("href", "/calendar");
			await expect(renewals.getByRole("link", { name: new RegExp(vendor) })).toHaveAttribute(
				"href",
				`/finance?subscription=${subscription.id}`,
			);
			await expect(renewals.getByRole("link", { name: "Subscriptions", exact: true })).toHaveAttribute(
				"href",
				"/finance",
			);
		};
		// The Subscriptions quick action leaves with Money Watch: once it is gone, the pane knows the user's modules.
		const showsNeither = async () => {
			await expect(center.getByRole("heading", { level: 2 })).toBeVisible();
			await expect(center.locator("[data-quick-action=compose]")).toBeVisible();
			await expect(center.locator('[data-quick-action="/finance"]')).toHaveCount(0);
			await expect(today).toHaveCount(0);
			await expect(renewals).toHaveCount(0);
		};
		await showsBoth();

		const access = (allowed: boolean) =>
			(["calendar", "finance"] as const).map((moduleId) => ({ userId: member.id, moduleId, allowed }));
		await setModuleState(owner, { access: access(false) });
		await openInbox(page);
		await showsNeither();

		await setModuleState(owner, { access: access(true) });
		await openInbox(page);
		await showsBoth();

		await setModuleState(owner, { modules: { calendar: false, finance: false } });
		await openInbox(page);
		await showsNeither();
	} finally {
		await restoreModules(owner, [member.id]);
		await context.close();
		await member.api.dispose();
		await owner.dispose();
	}
});
