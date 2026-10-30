import { expect, test, type Page, type Route } from "@playwright/test";

const STATUS_API = "/api/admin/migrations";
const PENDING_API = "/api/migrations/pending";
const NAMES = ["0101_add_column.sql", "0102_add_table.sql", "0103_add_index.sql", "0104_add_view.sql"];

/** A mocked server whose POST stays open until the test lets it go, with the pending list shrinking as it "applies". */
async function mockMigrations(page: Page) {
	let pending = [...NAMES];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const state = { posts: 0, outcome: "ok" as "ok" | "restore" | "failure" | "timeout" };

	const status = (route: Route) => route.fulfill({ json: { ready: !pending.length, pending, unknown: [] } });
	await page.context().route(`**${STATUS_API}`, async (route) => {
		if (route.request().method() !== "POST") return status(route);
		state.posts += 1;
		await gate;
		if (state.outcome === "restore") {
			return route.fulfill({ status: 409, json: { error: "A backup restore is running." } });
		}
		if (state.outcome === "timeout") {
			// Cloudflare gives up at 100 s; the Worker keeps migrating, which the pending list then shows.
			return route.fulfill({ status: 524, body: "error code: 524", contentType: "text/plain" });
		}
		if (state.outcome === "failure") {
			return route.fulfill({
				status: 500,
				json: {
					error:
						"Migration 0103_add_index.sql failed: disk full. A backup taken just before is listed on the Backups page.",
					backupId: "bak_e2e",
				},
			});
		}
		const applied = [...NAMES];
		pending = [];
		return route.fulfill({ json: { ready: true, pending, unknown: [], applied, backupId: "bak_e2e" } });
	});
	await page
		.context()
		.route(`**${PENDING_API}`, (route) =>
			route.fulfill({ json: { pending: pending.length, ...(pending.length ? { names: pending } : {}) } }),
		);
	return {
		state,
		/** Two updates have landed while the request is still open. */
		landTwo: () => (pending = pending.slice(2)),
		/** Every update has landed, as after a request the proxy gave up on. */
		landAll: () => (pending = []),
		finish: () => release?.(),
	};
}

async function expectBusy(panel: ReturnType<Page["getByRole"]>, busyName: string) {
	const button = panel.getByRole("button", { name: busyName });
	await expect(button).toBeDisabled();
	await expect(button).toHaveAttribute("aria-busy", "true");
	await expect(button).toHaveText("Updating database…");
}

test("the admin card shows the steps, progress and elapsed time while the update runs, then what was applied", async ({
	page,
}) => {
	const server = await mockMigrations(page);
	await page.goto("/admin");
	const panel = page.getByRole("region", { name: "Pending database updates" });
	await panel.getByRole("button", { name: "Update database" }).click();

	await expectBusy(panel, "Updating database…");
	const progress = panel.getByTestId("migration-progress");
	await expect(progress.getByRole("list", { name: "Update progress" })).toContainText(
		"Saving a safety backup, then applying…",
	);
	await expect(progress).toContainText(
		"Applying 4 updates (0101_add_column.sql, 0102_add_table.sql, 0103_add_index.sql and 1 more)",
	);
	await expect(progress.getByRole("progressbar")).toBeVisible();
	// The counter moves on its own, so a slow update never looks frozen.
	await expect(progress).toContainText(/Elapsed: [1-9]\d* s/);
	await expect(progress).toContainText("Keep this page open until it finishes.");

	// The server records updates one at a time; the steps follow.
	server.landTwo();
	await expect(progress).toContainText("Safety backup finished");
	await expect(progress).toContainText("Applying 4 updates: 2 of 4 done…");
	await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");

	server.finish();
	await expect(panel).toHaveCount(0);
	const done = page.getByRole("status").filter({ hasText: "Database updated" });
	await expect(done).toContainText("The database schema is up to date.");
	await expect(done).toContainText("4 database updates applied. A safety backup was saved first. Took");
	expect(server.state.posts).toBe(1);
});

test("leaving the page while the update runs asks for confirmation", async ({ page }) => {
	const server = await mockMigrations(page);
	await page.goto("/admin");
	const panel = page.getByRole("region", { name: "Pending database updates" });
	await panel.getByRole("button", { name: "Update database" }).click();
	await expectBusy(panel, "Updating database…");
	// Closing the tab runs its beforeunload handlers; the page asks before it goes.
	const dialog = page.waitForEvent("dialog");
	await page.close({ runBeforeUnload: true });
	const prompt = await dialog;
	expect(prompt.type()).toBe("beforeunload");
	await prompt.dismiss();
	server.finish();
});

test("the mailbox notice shows the same steps and ends with the result", async ({ page }) => {
	const server = await mockMigrations(page);
	await page.goto("/inbox");
	const notice = page.getByRole("region", { name: "Database updates" });
	await expect(notice).toContainText("still needs 4 updates");
	await notice.getByRole("button", { name: "Apply now" }).click();

	await expectBusy(notice, "Updating database…");
	await expect(notice.getByTestId("migration-progress")).toContainText("Saving a safety backup, then applying…");
	await expect(notice.getByTestId("migration-progress")).toContainText(/Elapsed: [1-9]\d* s/);
	server.landTwo();
	await expect(notice.getByTestId("migration-progress")).toContainText("2 of 4 done");

	server.finish();
	await expect(notice).toContainText("Database updated");
	await expect(notice).toContainText("4 database updates applied. A safety backup was saved first.");
	await expect(notice).not.toContainText("Kite was updated");
	await expect(notice.getByRole("button")).toHaveCount(0);
});

test("a failed update shows the server's message and the button works again", async ({ page }) => {
	const server = await mockMigrations(page);
	server.state.outcome = "failure";
	await page.goto("/admin");
	const panel = page.getByRole("region", { name: "Pending database updates" });
	await panel.getByRole("button", { name: "Update database" }).click();
	await expectBusy(panel, "Updating database…");
	server.finish();

	const alert = page.getByRole("alert").filter({ hasText: "The database update failed." });
	await expect(alert).toContainText("Migration 0103_add_index.sql failed: disk full.");
	await expect(alert).toContainText("A backup taken just before is listed on the Backups page.");
	await expect(alert).toContainText("Updates that already finished stay applied.");
	const button = panel.getByRole("button", { name: "Update database" });
	await expect(button).toBeEnabled();
	await expect(button).not.toHaveAttribute("aria-busy", "true");
	await expect(panel.getByTestId("migration-progress")).toHaveCount(0);
});

test("a restore in progress is explained, in the notice as well", async ({ page }) => {
	const server = await mockMigrations(page);
	server.state.outcome = "restore";
	await page.goto("/inbox");
	const notice = page.getByRole("region", { name: "Database updates" });
	await notice.getByRole("button", { name: "Apply now" }).click();
	await expectBusy(notice, "Updating database…");
	server.finish();

	await expect(notice.getByRole("alert")).toContainText("The database was not changed: a backup restore is running.");
	await expect(notice.getByRole("button", { name: "Apply now" })).toBeEnabled();
	await expect(notice).toContainText("still needs 4 updates");
});

test("a gateway timeout keeps the button busy and the run is followed until the updates have landed", async ({
	page,
}) => {
	const server = await mockMigrations(page);
	server.state.outcome = "timeout";
	await page.goto("/inbox");
	const notice = page.getByRole("region", { name: "Database updates" });
	await notice.getByRole("button", { name: "Apply now" }).click();
	await expectBusy(notice, "Updating database…");
	// The 524 answers; the Worker is still migrating, so nothing is reported as a failure.
	server.finish();
	const progress = notice.getByTestId("migration-progress");
	await expect(progress).toContainText("The connection timed out; the update may still be running — checking…");
	await expectBusy(notice, "Updating database…");
	await expect(notice.getByRole("alert")).toHaveCount(0);

	server.landTwo();
	await expect(progress).toContainText("2 of 4 done");
	await expect(progress).toContainText("The connection timed out");
	await expectBusy(notice, "Updating database…");

	server.landAll();
	await expect(notice).toContainText("Database updated");
	await expect(notice).toContainText("4 database updates applied.");
	await expect(notice).toContainText("The connection dropped meanwhile, so check the Backups page");
	await expect(notice.getByRole("alert")).toHaveCount(0);
	expect(server.state.posts).toBe(1);
});

test("another tab shows the busy state instead of an enabled Update database button", async ({ page }) => {
	const server = await mockMigrations(page);
	await page.goto("/admin");
	await page
		.getByRole("region", { name: "Pending database updates" })
		.getByRole("button", { name: "Update database" })
		.click();
	await expectBusy(page.getByRole("region", { name: "Pending database updates" }), "Updating database…");

	const other = await page.context().newPage();
	await other.goto("/admin");
	const panel = other.getByRole("region", { name: "Pending database updates" });
	await expectBusy(panel, "Updating database…");
	// Only the tab that runs the update shows its steps.
	await expect(panel.getByTestId("migration-progress")).toHaveCount(0);

	server.finish();
	await expect(other.getByText("The database schema is up to date.")).toBeVisible();
	await expect(page.getByText("The database schema is up to date.")).toBeVisible();
	expect(server.state.posts).toBe(1);
});

test("a request that never answers is cut off once the list is empty, and the run ends as recovered", async ({
	page,
}) => {
	test.setTimeout(90_000);
	const server = await mockMigrations(page);
	await page.goto("/inbox");
	const notice = page.getByRole("region", { name: "Database updates" });
	await notice.getByRole("button", { name: "Apply now" }).click();
	await expectBusy(notice, "Updating database…");

	// Every update has landed but the POST stays open (the gate is never released).
	server.landAll();
	await expect(notice).toContainText("Database updated", { timeout: 45_000 });
	await expect(notice).toContainText("4 database updates applied.");
	await expect(notice).toContainText("The connection dropped meanwhile, so check the Backups page");
	await expect(notice.getByRole("alert")).toHaveCount(0);
});

test("a tab that was already open reacts at once when another tab starts and ends the update", async ({ page }) => {
	const server = await mockMigrations(page);
	await page.goto("/admin");
	const other = await page.context().newPage();
	await other.goto("/admin");
	const otherPanel = other.getByRole("region", { name: "Pending database updates" });
	await expect(otherPanel.getByRole("button", { name: "Update database" })).toBeEnabled();

	await page
		.getByRole("region", { name: "Pending database updates" })
		.getByRole("button", { name: "Update database" })
		.click();
	// Well inside the periodic re-check (5 s): the other tab was told.
	await expect(otherPanel.getByRole("button", { name: "Updating database…" })).toBeDisabled({ timeout: 2_000 });
	await expect(otherPanel.getByTestId("migration-progress")).toHaveCount(0);

	server.finish();
	await expect(other.getByText("The database schema is up to date.")).toBeVisible({ timeout: 4_000 });
});
