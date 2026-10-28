import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption, expectSelectValue } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// The workerd dev server's `connect()` reaching the fake IMAP server on 127.0.0.1. Plain text is allowed only there,
// only because playwright.config.ts sets EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK; tests/imap-node.test.mjs covers
// TLS and STARTTLS on the Node runtime.

const USER = "user@example.test";
const PASSWORD = "app-password";

test("IMAP import reads folders, imports a batch and runs a background job from the fake server", async () => {
	test.setTimeout(120_000);
	const inbox = uniqueToken("imapinbox");
	const archive = uniqueToken("imaparchive");
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [sampleMessage(1, { subject: `${inbox} one` }), sampleMessage(2, { subject: `${inbox} two` })],
			Archive: [sampleMessage(3, { subject: `${archive} old` })],
		},
	});
	const api = await apiContext(STORAGE_STATE);
	let jobId = "";
	try {
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const account = { host: fake.host, port: fake.port, secure: false, username: USER, password: PASSWORD };

		const listed = await api.post("/api/import/imap/folders", { data: account });
		expect(listed.status(), await listed.text()).toBe(200);
		expect(((await listed.json()) as { folders: string[] }).folders).toEqual(["INBOX", "Archive"]);

		const imported = await api.post("/api/import/imap", {
			data: { ...account, mailboxId: mailboxes[0].id, folder: "INBOX", destination: "system:inbox", limit: 10 },
		});
		expect(imported.status(), await imported.text()).toBe(200);
		expect(await imported.json()).toMatchObject({ imported: 2, total: 2, nextOffset: null });
		await waitForMessage(api, `${inbox} one`);
		await waitForMessage(api, `${inbox} two`);

		const created = await api.post("/api/import/jobs", {
			data: {
				...account,
				mailboxId: mailboxes[0].id,
				folder: "Archive",
				destination: "system:archived",
				importAll: true,
			},
		});
		expect(created.status(), await created.text()).toBe(201);
		jobId = ((await created.json()) as { job: { id: string } }).job.id;
		await expect
			.poll(
				async () => {
					const { jobs } = (await (await api.get("/api/import/jobs")).json()) as {
						jobs: { id: string; status: string; imported: number }[];
					};
					const job = jobs.find((entry) => entry.id === jobId);
					return job && `${job.status}:${job.imported}`;
				},
				{ timeout: 60_000, intervals: [500, 1000] },
			)
			.toBe("completed:1");
		await waitForMessage(api, `${archive} old`, { status: "archived" });
		// BODY.PEEK[] never marks the source mail as read.
		expect(fake.commands.some((entry) => /BODY\[\]/i.test(entry.line) && !/PEEK/i.test(entry.line))).toBe(false);
	} finally {
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
		await fake.close();
	}
});

type ImportedRow = { subject: string; read: boolean; starred: boolean; threadId: string | null; createdAt: string };

test("IMAP import keeps read and starred state, dedupes without a Message-ID and threads a reply imported first", async () => {
	test.setTimeout(120_000);
	const token = uniqueToken("imapstate");
	const root = `<${token}-root@example.org>`;
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [
				{ raw: sampleMessage(1, { subject: `${token} root`, messageId: root }), flags: ["\\Seen"] },
				{
					raw: sampleMessage(2, { subject: `${token} reply`, inReplyTo: root, references: root }),
					flags: ["\\Flagged"],
				},
				{
					raw: sampleMessage(3, { subject: `${token} undated`, messageId: null, date: null }),
					internalDate: "01-Feb-2025 08:30:00 +0000",
				},
			],
		},
	});
	const api = await apiContext(STORAGE_STATE);
	let jobId = "";
	try {
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const source = {
			host: fake.host,
			port: fake.port,
			secure: false,
			username: USER,
			password: PASSWORD,
			mailboxId: mailboxes[0].id,
			folder: "INBOX",
			destination: "system:inbox",
		};
		const imported = await api.post("/api/import/imap", { data: { ...source, limit: 10 } });
		expect(imported.status(), await imported.text()).toBe(200);
		expect(await imported.json()).toMatchObject({ imported: 3, skipped: 0 });

		const row = async (suffix: string) => (await waitForMessage(api, `${token} ${suffix}`)) as unknown as ImportedRow;
		const [rootRow, replyRow, undatedRow] = [await row("root"), await row("reply"), await row("undated")];
		expect([rootRow.read, rootRow.starred]).toEqual([true, false]);
		expect([replyRow.read, replyRow.starred]).toEqual([false, true]);
		expect(undatedRow.read).toBe(false);
		// The reply (newest) was imported before its parent and still joined its conversation.
		expect(replyRow.threadId).toBe(rootRow.threadId);
		expect(new Date(undatedRow.createdAt).toISOString()).toBe("2025-02-01T08:30:00.000Z");

		// A background job over the same folder recognises all three, including the one without a Message-ID.
		const created = await api.post("/api/import/jobs", { data: { ...source, importAll: true } });
		expect(created.status(), await created.text()).toBe(201);
		jobId = ((await created.json()) as { job: { id: string } }).job.id;
		await expect
			.poll(
				async () => {
					const { jobs } = (await (await api.get("/api/import/jobs")).json()) as {
						jobs: { id: string; status: string; imported: number; skipped: number }[];
					};
					const job = jobs.find((entry) => entry.id === jobId);
					return job && `${job.status}:${job.imported}:${job.skipped}`;
				},
				{ timeout: 60_000, intervals: [500, 1000] },
			)
			.toBe("completed:0:3");
	} finally {
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
		await fake.close();
	}
});

test("IMAP import refuses other ports and local hosts before it connects", async () => {
	const api = await apiContext(STORAGE_STATE);
	try {
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const base = { username: USER, password: PASSWORD, mailboxId: mailboxes[0].id, folder: "INBOX" };
		const port = await api.post("/api/import/jobs", { data: { ...base, host: "imap.example.com", port: 25 } });
		expect(port.status()).toBe(400);
		expect(((await port.json()) as { error: string }).error).toMatch(/Port 25 is not allowed.*993 or 143/);
		const local = await api.post("/api/import/imap/folders", { data: { ...base, host: "10.0.0.5", port: 993 } });
		expect(local.status()).toBe(400);
		expect(((await local.json()) as { error: string }).error).toMatch(/Private and local mail servers/);
	} finally {
		await api.dispose();
	}
});

test("the IMAP form offers TLS or STARTTLS, and the port follows the choice", async ({ page }) => {
	await page.goto("/settings/import");
	await chooseOption(page.locator("#import-source"), "imap");
	const encryption = page.locator("#imap-security");
	const port = page.locator("#imap-port");
	await expectSelectValue(encryption, "tls");
	await expect(port).toHaveValue("993");
	await expect(page.getByText("Kite only connects over an encrypted connection")).toBeVisible();
	await chooseOption(encryption, "starttls");
	await expect(port).toHaveValue("143");
	await chooseOption(encryption, "tls");
	await expect(port).toHaveValue("993");
	// A port the user typed stays.
	await port.fill("10993");
	await chooseOption(encryption, "starttls");
	await expect(port).toHaveValue("10993");
});
