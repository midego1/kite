import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Whole-account imports (spec §4.1, §4.5) from the fake IMAP server on 127.0.0.1, reached by the workerd dev
// server's connect() under EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: the mapping table, folders copied one after
// another, Gmail's labels, pause and resume, and the table in every style.

const USER = "user@example.test";
const PASSWORD = "app-password";

type ImportJobFolder = { sourceName: string; status: string; imported: number; skipped: number; multiLabel: number };
type ImportJob = { id: string; status: string; imported: number; processed: number; folders: ImportJobFolder[] };

async function readJob(api: APIRequestContext, id: string): Promise<ImportJob | undefined> {
	// The dev server may be busy importing (and compiling the route on first use).
	const { jobs } = (await (await api.get("/api/import/jobs", { timeout: 60_000 })).json()) as { jobs: ImportJob[] };
	return jobs.find((job) => job.id === id);
}

async function firstMailboxId(api: APIRequestContext): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	return mailboxes[0].id;
}

/** Fills the IMAP form for the fake server, in whole-account mode. */
async function fillAccountForm(page: Page, port: number) {
	await page.goto("/settings/import");
	await chooseOption(page.locator("#import-source"), { label: "IMAP" });
	await expect(page.locator("#imap-mode")).toContainText("Whole account");
	// Plain text is allowed only to this loopback fake, and only when STARTTLS is chosen and the server lacks it.
	await chooseOption(page.locator("#imap-security"), "starttls");
	await page.locator("#imap-host").fill("127.0.0.1");
	await page.locator("#imap-port").fill(String(port));
	await page.locator("#imap-username").fill(USER);
	await page.locator("#imap-password").fill(PASSWORD);
}

test("a whole account is shown as a mapping table, copied folder by folder and listed with each folder's progress", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const token = uniqueToken("acct");
	const fake = await startFakeImap({
		authPlain: true,
		specialUse: true,
		statusSize: true,
		folderAttributes: { "Sent Items": ["\\Sent"], Junk: ["\\Junk"], Trash: ["\\Trash"], Drafts: ["\\Drafts"] },
		folders: {
			INBOX: [
				{ raw: sampleMessage(1, { subject: `${token} inbox read` }), flags: ["\\Seen"] },
				sampleMessage(2, { subject: `${token} inbox` }),
			],
			"Sent Items": [sampleMessage(3, { subject: `${token} sent` })],
			[`Projects/${token}`]: [sampleMessage(4, { subject: `${token} project` })],
			Junk: [sampleMessage(5, { subject: `${token} junk` })],
			Trash: [sampleMessage(6, { subject: `${token} trash` })],
			Drafts: [sampleMessage(7, { subject: `${token} draft` })],
		},
	});
	const api = await apiContext(STORAGE_STATE);
	let jobId = "";
	try {
		await fillAccountForm(page, fake.port);
		await page.getByRole("button", { name: "Show folders" }).click();
		const table = page.getByRole("table", { name: "Folders to import" });
		await expect(table).toBeVisible();
		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(5);
		await expect(rows.nth(0)).toContainText("INBOX");
		await expect(rows.nth(0)).toContainText("2");
		await expect(rows.nth(2)).toContainText(`Projects / ${token}`);
		await expect(page.getByLabel(`Where Projects / ${token} goes`)).toContainText(`New folder: Projects / ${token}`);
		// Drafts are not offered; Junk and Trash are, switched off.
		await expect(table).not.toContainText("Drafts");
		await expect(page.getByRole("checkbox", { name: "Import Junk" })).not.toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Import Trash" })).not.toBeChecked();
		await page.getByRole("checkbox", { name: "Import Junk" }).check();

		const created = page.waitForResponse(
			(response) => response.url().endsWith("/api/import/jobs") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Import account" }).click();
		jobId = ((await (await created).json()) as { job: { id: string } }).job.id;
		await expect(page.getByText("Started the import of the account.")).toBeVisible();

		await expect
			.poll(async () => (await readJob(api, jobId))?.status, { timeout: 60_000, intervals: [500, 1000] })
			.toBe("completed");
		const job = (await readJob(api, jobId))!;
		expect(job.folders.map((folder) => [folder.sourceName, folder.status, folder.imported])).toEqual([
			["INBOX", "completed", 2],
			["Sent Items", "completed", 1],
			[`Projects/${token}`, "completed", 1],
			["Junk", "completed", 1],
		]);
		const list = page.getByRole("list", { name: "Folders" }).first();
		await expect(list).toContainText(`Projects/${token} → Projects / ${token}`);
		await expect(list).toContainText("Junk → Spam");

		const read = (await waitForMessage(api, `${token} inbox read`)) as unknown as { read: boolean };
		expect(read.read).toBe(true);
		expect((await waitForMessage(api, `${token} sent`, { status: "sent" })).status).toBe("sent");
		expect((await waitForMessage(api, `${token} junk`, { status: "spam" })).status).toBe("spam");
		const project = (await waitForMessage(api, `${token} project`)) as unknown as { folderId: string | null };
		expect(project.folderId).toBeTruthy();
	} finally {
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
		await fake.close();
	}
});

test("a Gmail account is copied once from All Mail by label, and an import pauses and resumes where it stopped", async () => {
	test.setTimeout(240_000);
	const token = uniqueToken("gmail");
	const labelled = Array.from({ length: 150 }, (_, index) => ({
		raw: sampleMessage(index + 10, { subject: `${token} bulk ${index}` }),
		labels: ["\\Inbox"],
	}));
	const fake = await startFakeImap({
		authPlain: true,
		gmail: true,
		specialUse: true,
		// A slow server, so the pause lands while the job is copying.
		fetchDelayMs: 3000,
		folderAttributes: { "[Gmail]/All Mail": ["\\All"], "[Gmail]/Spam": ["\\Junk"], "[Gmail]/Sent Mail": ["\\Sent"] },
		folders: {
			INBOX: [sampleMessage(1, { subject: `${token} duplicate view` })],
			"[Gmail]/All Mail": [
				{ raw: sampleMessage(2, { subject: `${token} sent` }), labels: ["\\Sent"] },
				{ raw: sampleMessage(3, { subject: `${token} two labels` }), labels: [`${token}-b`, `${token}-a`] },
				{ raw: sampleMessage(4, { subject: `${token} unlabelled` }), labels: [] },
				{ raw: sampleMessage(5, { subject: `${token} draft` }), labels: ["\\Draft"] },
				...labelled,
			],
			"[Gmail]/Sent Mail": [sampleMessage(2, { subject: `${token} sent view` })],
			"[Gmail]/Spam": [sampleMessage(6, { subject: `${token} spam` })],
		},
	});
	const api = await apiContext(STORAGE_STATE);
	let jobId = "";
	try {
		const account = { host: fake.host, port: fake.port, secure: false, username: USER, password: PASSWORD };
		const planned = await api.post("/api/import/account/plan", { data: account });
		expect(planned.status(), await planned.text()).toBe(200);
		const plan = (await planned.json()) as { gmail: boolean; folders: { sourceName: string; include: boolean }[] };
		expect(plan.gmail).toBe(true);
		expect(plan.folders.map((folder) => [folder.sourceName, folder.include])).toEqual([
			["[Gmail]/All Mail", true],
			["[Gmail]/Spam", false],
		]);

		const created = await api.post("/api/import/jobs", {
			data: { scope: "account", mailboxId: await firstMailboxId(api), ...account, folders: plan.folders },
		});
		expect(created.status(), await created.text()).toBe(201);
		jobId = ((await created.json()) as { job: { id: string } }).job.id;

		await expect.poll(async () => (await readJob(api, jobId))?.processed, { timeout: 60_000 }).toBeGreaterThan(0);
		expect((await api.post(`/api/import/jobs/${jobId}/pause`)).status()).toBe(200);
		await expect.poll(async () => (await readJob(api, jobId))?.status, { timeout: 15_000 }).toBe("paused");
		// A batch already running finishes; after that nothing moves while the job is paused.
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const paused = (await readJob(api, jobId))!;
		await new Promise((resolve) => setTimeout(resolve, 4000));
		expect((await readJob(api, jobId))!.processed).toBe(paused.processed);
		expect(paused.processed).toBeLessThan(154);

		expect((await api.post(`/api/import/jobs/${jobId}/resume`, { data: {} })).status()).toBe(200);
		await expect
			.poll(async () => (await readJob(api, jobId))?.status, { timeout: 120_000, intervals: [1000] })
			.toBe("completed");
		const [folder] = (await readJob(api, jobId))!.folders;
		expect([folder.imported, folder.skipped, folder.multiLabel]).toEqual([153, 1, 1]);

		expect((await waitForMessage(api, `${token} sent`, { status: "sent" })).status).toBe("sent");
		expect((await waitForMessage(api, `${token} unlabelled`, { status: "archived" })).status).toBe("archived");
		const filed = (await waitForMessage(api, `${token} two labels`)) as unknown as { folderId: string };
		const { folders } = (await (await api.get(`/api/folders?mailboxId=${await firstMailboxId(api)}`)).json()) as {
			folders: { id: string; name: string }[];
		};
		expect(folders.find((entry) => entry.id === filed.folderId)?.name).toBe(`${token}-a`);
		await waitForMessage(api, `${token} bulk 149`);
	} finally {
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
		await fake.close();
	}
});

test("account imports need the module, a session and an IMAP port, and validate their folders", async () => {
	const api = await apiContext(STORAGE_STATE);
	const anonymous = await apiContext();
	try {
		const base = { username: USER, password: PASSWORD };
		expect((await anonymous.post("/api/import/account/plan", { data: base })).status()).toBe(401);
		const port = await api.post("/api/import/account/plan", { data: { ...base, host: "imap.example.com", port: 25 } });
		expect(port.status()).toBe(400);
		const bad = await api.post("/api/import/jobs", {
			data: {
				scope: "account",
				mailboxId: await firstMailboxId(api),
				...base,
				host: "imap.example.com",
				port: 993,
				folders: [{ sourceName: "INBOX", role: "inbox", destination: "system:drafts" }],
			},
		});
		expect(bad.status()).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toMatch(/Choose where INBOX goes/);
		expect((await api.post("/api/import/jobs/ijob_missing/pause")).status()).toBe(404);
	} finally {
		await anonymous.dispose();
		await api.dispose();
	}
});

test("the mapping table reads in Kite, Kite light, Classic and dark mode", async ({ browser }, testInfo) => {
	test.setTimeout(150_000);
	const fake = await startFakeImap({
		authPlain: true,
		specialUse: true,
		folderAttributes: { Junk: ["\\Junk"] },
		folders: { INBOX: [sampleMessage(1)], Junk: [sampleMessage(2)], Clients: [sampleMessage(3)] },
	});
	const variants = [
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	];
	try {
		for (const variant of variants) {
			const context = await browser.newContext({ storageState: STORAGE_STATE });
			const page = await context.newPage();
			try {
				await page.addInitScript(({ style, theme }) => {
					localStorage.setItem("kite-style", style);
					localStorage.setItem("kite-theme", theme);
				}, variant);
				await fillAccountForm(page, fake.port);
				await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
				await page.getByRole("button", { name: "Show folders" }).click();
				const name = page.getByRole("table", { name: "Folders to import" }).getByText("Clients", { exact: true });
				await expect(name).toBeVisible();
				const [text, background] = await name.evaluate((element) => {
					const canvas = document.createElement("canvas").getContext("2d")!;
					const luminance = (color: string) => {
						canvas.clearRect(0, 0, 1, 1);
						canvas.fillStyle = color;
						canvas.fillRect(0, 0, 1, 1);
						const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
						return 0.2126 * r + 0.7152 * g + 0.0722 * b;
					};
					// The nearest ancestor that paints a background is what the text sits on.
					let node: Element | null = element;
					let fill = "rgba(0, 0, 0, 0)";
					while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(fill)) {
						fill = getComputedStyle(node).backgroundColor;
						node = node.parentElement;
					}
					return [luminance(getComputedStyle(element).color), luminance(fill)];
				});
				expect(Math.abs(text - background), variant.name).toBeGreaterThan(100);
				await page.screenshot({ path: testInfo.outputPath(`import-account-${variant.name}.png`) });
			} finally {
				await context.close();
			}
		}
	} finally {
		await fake.close();
	}
});
