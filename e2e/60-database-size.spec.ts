import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { E2E_PERSIST_DIR, STORAGE_STATE } from "./support/constants";
import { apiContext } from "./support/helpers";
import { chooseOption } from "./support/select";

const SIZE_HEADER = "x-kite-test-database-size";
const GB = 1_000_000_000;
const sizeAt = (used: number) => `used=${used};limit=${10 * GB}`;
const JOB_ID = "ijob_e2e_size_paused";

function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	);
}

/** Every call to these routes carries the injected size, as if the database held that much. */
async function injectSize(page: Page, header: string | null) {
	await page.route(/\/api\/(admin\/database-size|import\/estimate)/, (route) =>
		route.continue({ headers: header ? { ...route.request().headers(), [SIZE_HEADER]: header } : undefined }),
	);
}

async function mailboxId(api: APIRequestContext): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	return mailboxes[0].id;
}

function jobRequest(id: string) {
	return {
		mailboxId: id,
		destination: "system:inbox",
		host: "imap.e2e.invalid",
		port: 993,
		username: "someone@e2e.invalid",
		password: "not-a-real-password",
		folder: "INBOX",
		importAll: false,
		limit: 50,
	};
}

test("the real database size is reported against the 10 GB limit", async () => {
	const api = await apiContext(STORAGE_STATE);
	try {
		const response = await api.get("/api/admin/database-size");
		expect(response.status()).toBe(200);
		const body = (await response.json()) as { size: { usedBytes: number; limitBytes: number | null }; level: string };
		expect(body.size.usedBytes).toBeGreaterThan(100_000);
		expect(body.size.limitBytes).toBe(10 * GB);
		expect(body.level).toBe("ok");
	} finally {
		await api.dispose();
	}
});

test("the admin overview warns from 70% and turns red from 90% of the database limit", async ({ page }) => {
	await injectSize(page, sizeAt(3 * GB));
	await page.goto("/admin");
	const card = page.getByTestId("database-size-card");
	await expect(card).toHaveAttribute("data-level", "ok");
	await expect(card).toContainText("3 GB of 10 GB (30%)");
	await expect(card.getByRole("status")).toHaveCount(0);

	await page.unrouteAll();
	await injectSize(page, sizeAt(7.4 * GB));
	await page.goto("/admin");
	await expect(card).toHaveAttribute("data-level", "warn");
	await expect(card).toContainText("7.4 GB of 10 GB (74%)");
	await expect(card.getByRole("status")).toContainText("above 70%");

	await page.unrouteAll();
	await injectSize(page, sizeAt(9.3 * GB));
	await page.goto("/admin");
	await expect(card).toHaveAttribute("data-level", "critical");
	await expect(card.getByRole("alert")).toContainText("above 90%");
	await expect(card.getByRole("alert")).toContainText("D1_MAX_BYTES=500000000");
});

test("the import page asks for Import anyway only above 90% of the database limit", async ({ page }) => {
	await injectSize(page, sizeAt(9.4 * GB));
	await page.goto("/settings/import");
	await chooseOption(page.locator("#import-source"), { label: "IMAP" });
	await page.locator("#imap-host").fill("imap.e2e.invalid");
	await page.locator("#imap-username").fill("someone@e2e.invalid");
	await page.locator("#imap-password").fill("not-a-real-password");

	const submit = page.getByRole("button", { name: "Import selected sources" });
	const notice = page.getByTestId("import-size-notice");
	await expect(notice).toContainText("The database is now 9.4 GB of 10 GB");
	await expect(notice).toContainText("above 90%");
	await expect(submit).toBeDisabled();
	await notice.getByLabel("Import anyway").check();
	await expect(submit).toBeEnabled();

	await page.unrouteAll();
	await injectSize(page, sizeAt(7.5 * GB));
	await page.reload();
	await chooseOption(page.locator("#import-source"), { label: "IMAP" });
	await expect(notice).toContainText("above 70%");
	await expect(notice.getByLabel("Import anyway")).toHaveCount(0);

	await page.unrouteAll();
	await injectSize(page, sizeAt(2 * GB));
	await page.reload();
	await chooseOption(page.locator("#import-source"), { label: "IMAP" });
	await expect(notice).toHaveCount(0);
});

test("starting an import above 90% of the database limit needs confirmation on the server too", async () => {
	const api = await apiContext(STORAGE_STATE);
	const started: string[] = [];
	try {
		const id = await mailboxId(api);
		const critical = { [SIZE_HEADER]: sizeAt(9.2 * GB) };

		const refused = await api.post("/api/import/jobs", { data: jobRequest(id), headers: critical });
		expect(refused.status()).toBe(409);
		const body = (await refused.json()) as { code: string; estimate: { requiresConfirmation: boolean } };
		expect(body.code).toBe("DATABASE_NEARLY_FULL");
		expect(body.estimate.requiresConfirmation).toBe(true);

		const confirmed = await api.post("/api/import/jobs", {
			data: { ...jobRequest(id), confirmDatabaseFull: true },
			headers: critical,
		});
		expect(confirmed.status()).toBe(201);
		started.push(((await confirmed.json()) as { job: { id: string } }).job.id);

		// A small import into a roomy database needs nothing.
		const roomy = await api.post("/api/import/jobs", {
			data: jobRequest(id),
			headers: { [SIZE_HEADER]: sizeAt(1 * GB) },
		});
		expect(roomy.status()).toBe(201);
		started.push(((await roomy.json()) as { job: { id: string } }).job.id);

		// The projection counts what the import adds: 8.5 GB is a warning, 8.5 GB plus 100,000 messages is not.
		const projected = await api.post("/api/import/estimate", {
			data: { messages: 100_000 },
			headers: { [SIZE_HEADER]: sizeAt(8.5 * GB) },
		});
		const { estimate } = (await projected.json()) as {
			estimate: { projectedLevel: string; currentLevel: string; requiresConfirmation: boolean };
		};
		expect(estimate.currentLevel).toBe("warn");
		expect(estimate.projectedLevel).toBe("critical");
		expect(estimate.requiresConfirmation).toBe(true);
	} finally {
		for (const id of started) await api.delete(`/api/import/jobs/${id}`);
		await api.dispose();
	}
});

test("an import that paused for the database size resumes only after confirmation while it is still full", async () => {
	const api = await apiContext(STORAGE_STATE);
	try {
		const id = await mailboxId(api);
		sql(`DELETE FROM import_jobs WHERE id = '${JOB_ID}'`);
		sql(
			"INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, last_error, created_at, updated_at) " +
				`VALUES ('${JOB_ID}', (SELECT id FROM users WHERE email='admin@example.com'), '${id}', 'Paused e2e', 'system:inbox', 'imap.e2e.invalid', 993, 1, 'someone@e2e.invalid', '', 'INBOX', 'paused', 'Paused: the database is above 90% of its size limit.', unixepoch(), unixepoch())`,
		);
		const critical = { [SIZE_HEADER]: sizeAt(9.2 * GB) };
		const asked = await api.post(`/api/import/jobs/${JOB_ID}/resume`, { data: {}, headers: critical });
		expect(asked.status()).toBe(409);
		expect(((await asked.json()) as { code: string }).code).toBe("DATABASE_NEARLY_FULL");

		const resumed = await api.post(`/api/import/jobs/${JOB_ID}/resume`, {
			data: { confirmDatabaseFull: true },
			headers: critical,
		});
		expect(resumed.status()).toBe(200);
		const jobs = (await (await api.get("/api/import/jobs")).json()) as { jobs: { id: string; status: string }[] };
		expect(jobs.jobs.find((job) => job.id === JOB_ID)?.status).not.toBe("paused");
		expect((await api.post(`/api/import/jobs/${JOB_ID}/resume`, { data: {} })).status()).toBe(404);
	} finally {
		await api.delete(`/api/import/jobs/${JOB_ID}`);
		sql(`DELETE FROM import_jobs WHERE id = '${JOB_ID}'`);
		await api.dispose();
	}
});
