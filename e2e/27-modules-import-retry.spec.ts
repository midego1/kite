import { expect, test, type APIRequestContext } from "@playwright/test";
import { uniqueToken } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { expectEveryModuleOn, owner } from "./support/module-spec";

type ImportJobRow = { id: string; status: string; attempts: number; lastError: string | null; updatedAt: string };

async function importJob(api: APIRequestContext, id: string): Promise<ImportJobRow | undefined> {
	const response = await api.get("/api/import/jobs");
	expect(response.status()).toBe(200);
	return ((await response.json()) as { jobs: ImportJobRow[] }).jobs.find((job) => job.id === id);
}

// Not a local host: the import refuses those for good ("not allowed"), so that job would fail at once; an
// unresolvable public name fails the way a flaky server does and is retried.
test("a queued import retry that arrives while Import is off is skipped and the job resumes unchanged", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const api = await owner();
	let jobId = "";
	try {
		const mailboxes = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const created = await api.post("/api/import/jobs", {
			data: {
				mailboxId: mailboxes.mailboxes[0].id,
				host: "imap.no-such-host.example.net",
				port: 993,
				secure: true,
				username: "nobody",
				password: "not-a-password",
				folder: "INBOX",
				label: uniqueToken("pausedimport"),
				importAll: true,
			},
		});
		expect(created.status(), await created.text()).toBe(201);
		const { job: first } = (await created.json()) as { job: { id: string; label: string } };
		jobId = first.id;

		await expect
			.poll(async () => (await importJob(api, jobId))?.attempts, { timeout: 30_000, intervals: [500] })
			.toBe(1);
		const before = (await importJob(api, jobId))!;
		expect(before.lastError).toBeTruthy();
		expect(["pending", "running"]).toContain(before.status);

		// The retry is queued 30 seconds out; Import stays off until it has been delivered and acked.
		await setModuleState(api, { modules: { import: false } });
		await page.waitForTimeout(45_000);
		await setModuleState(api, { modules: { import: true } });

		const after = (await importJob(api, jobId))!;
		expect(after.attempts).toBe(1);
		expect(after.lastError).toBe(before.lastError);
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(["pending", "running"]).toContain(after.status);
		await page.goto("/settings/import");
		await expect(page.getByText(first.label)).toBeVisible();
	} finally {
		await restoreModules(api);
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
	}
});

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});
