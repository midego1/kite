import { expect, test, type Page } from "@playwright/test";
import { chooseOption } from "./support/select";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Sizes on the whole-account import page: the folder table and the always-visible totals (messages, size at the
// source, what the import adds to mail storage and the database). A server with STATUS=SIZE gives sizes at once;
// without it the page measures each folder in steps (UID FETCH RFC822.SIZE), shows how far it is and never blocks
// the import. The warning above 70% of the database limit uses those sizes.

const USER = "user@example.test";
const PASSWORD = "app-password";
const SIZE_HEADER = "x-kite-test-database-size";
const GB = 1_000_000_000;

/** Messages of a stated size (RFC822.SIZE), so the totals are known exactly. */
function weighted(count: number, bytes: number, label: string) {
	return Array.from({ length: count }, (_, index) => ({
		raw: sampleMessage(index + 1, { subject: `${label} ${index + 1}` }),
		size: bytes,
	}));
}

async function showFolders(page: Page, port: number) {
	await page.goto("/settings/import");
	await chooseOption(page.locator("#import-source"), { label: "IMAP" });
	await expect(page.locator("#imap-mode")).toContainText("Whole account");
	await chooseOption(page.locator("#imap-security"), "starttls");
	await page.locator("#imap-host").fill("127.0.0.1");
	await page.locator("#imap-port").fill(String(port));
	await page.locator("#imap-username").fill(USER);
	await page.locator("#imap-password").fill(PASSWORD);
	await page.getByRole("button", { name: "Show folders" }).click();
	return page.getByRole("table", { name: "Folders to import" });
}

test("without STATUS=SIZE the folders are measured in the background, shown as they go and added up", async ({
	page,
}) => {
	test.setTimeout(90_000);
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const fake = await startFakeImap({
		authPlain: true,
		fetchGate: () => gate,
		folders: { INBOX: weighted(20, 100_000, "inbox"), Sent: weighted(10, 50_000, "sent") },
	});
	try {
		const table = await showFolders(page, fake.port);
		await expect(table.locator("tbody tr")).toHaveCount(2);
		const inbox = table.locator("tbody tr").nth(0);
		const sent = table.locator("tbody tr").nth(1);
		// The count is known from the start; the size is being measured and says so. Starting is not held back.
		await expect(inbox).toContainText("20");
		await expect(inbox.locator("[data-size]")).toHaveAttribute("data-size", "measuring");
		await expect(inbox).toContainText("measuring 0%");
		const totals = page.getByTestId("import-size-total");
		await expect(totals.locator('[data-total="messages"]')).toContainText("30");
		await expect(totals.locator('[data-total="source"]')).toContainText("Not known yet");
		await expect(totals).toContainText("Still measuring 2 folders");
		await expect(totals).toContainText("upper bound");
		await expect(page.getByRole("button", { name: "Import account" })).toBeEnabled();

		release();
		// 20 × 100,000 and 10 × 50,000 bytes, as the folders' own RFC822.SIZE say.
		await expect(inbox.locator("[data-size]")).toHaveAttribute("data-size", "exact");
		await expect(inbox).toContainText("2 MB");
		await expect(sent).toContainText("500 KB");
		await expect(totals.locator('[data-total="source"]')).toHaveText(/2\.5 MB/);
		await expect(totals.locator('[data-total="source"]')).not.toContainText("estimate");
		// The raw message is stored once, so the mail store grows by the same amount; the database row is there too.
		await expect(totals.locator('[data-total="mail-store"]')).toContainText("2.5 MB");
		await expect(totals.locator('[data-total="database"]')).toContainText("Adds to the database");
		await expect(totals).not.toContainText("Still measuring");
		// Only sizes were asked for: no message body was fetched to measure.
		const fetches = fake.commands
			.map((entry: { line: string }) => entry.line)
			.filter((line: string) => /\bFETCH\b/i.test(line));
		expect(fetches.length).toBeGreaterThanOrEqual(2);
		expect(fetches.every((line: string) => /RFC822\.SIZE/.test(line) && !/BODY/i.test(line))).toBe(true);
	} finally {
		release();
		await fake.close();
	}
});

test("a server with STATUS=SIZE gives the sizes at once and nothing is measured", async ({ page }) => {
	const fake = await startFakeImap({
		authPlain: true,
		specialUse: true,
		statusSize: true,
		folders: { INBOX: weighted(8, 1000, "status") },
	});
	try {
		const table = await showFolders(page, fake.port);
		const inbox = table.locator("tbody tr").nth(0);
		await expect(inbox.locator("[data-size]")).toHaveAttribute("data-size", "exact");
		const totals = page.getByTestId("import-size-total");
		await expect(totals.locator('[data-total="messages"]')).toContainText("8");
		await expect(totals.locator('[data-total="source"]')).not.toContainText("Not known");
		await expect(totals).not.toContainText("Still measuring");
		expect(fake.commands.some((entry: { line: string }) => /\bFETCH\b/i.test(entry.line))).toBe(false);
	} finally {
		await fake.close();
	}
});

test("a folder whose measuring fails keeps the size unknown, says so, and the import is not blocked", async ({
	page,
}) => {
	test.setTimeout(90_000);
	const fake = await startFakeImap({
		authPlain: true,
		examineRefusals: { INBOX: "NO [UNAVAILABLE] try again later" },
		folders: { INBOX: weighted(5, 1000, "refused") },
	});
	try {
		const table = await showFolders(page, fake.port);
		const inbox = table.locator("tbody tr").nth(0);
		// Two retries a moment apart, then the folder is marked failed.
		await expect(inbox.locator("[data-size]")).toHaveAttribute("data-size", "unknown", { timeout: 30_000 });
		const totals = page.getByTestId("import-size-total");
		await expect(totals).toContainText("did not work just now");
		await expect(totals).toContainText("size stays unknown");
		await expect(totals.locator('[data-total="source"]')).toContainText("Not known yet");
		await expect(totals.locator('[data-total="messages"]')).toContainText("5");
		await expect(page.getByRole("button", { name: "Import account" })).toBeEnabled();
	} finally {
		await fake.close();
	}
});

test("a server that sends no sizes leaves the size unknown instead of showing 0 B", async ({ page }) => {
	const fake = await startFakeImap({
		authPlain: true,
		folders: { INBOX: Array.from({ length: 6 }, (_, index) => ({ raw: sampleMessage(index + 1), size: null })) },
	});
	try {
		const table = await showFolders(page, fake.port);
		await expect(table.locator("tbody tr").nth(0).locator("[data-size]")).toHaveAttribute("data-size", "unknown");
		const totals = page.getByTestId("import-size-total");
		await expect(totals).toContainText("did not say how big 1 folder is");
		await expect(totals.locator('[data-total="source"]')).toContainText("Not known yet");
		await expect(totals).not.toContainText("0 B");
	} finally {
		await fake.close();
	}
});

test("a folder with few messages and a huge UIDNEXT is measured in one request", async ({ page }) => {
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [
				{ raw: sampleMessage(1), size: 1000, uid: 5_000_000 },
				{ raw: sampleMessage(2), size: 2000, uid: 9_000_000 },
			],
		},
	});
	try {
		const table = await showFolders(page, fake.port);
		await expect(table.locator("tbody tr").nth(0).locator("[data-size]")).toHaveAttribute("data-size", "exact");
		await expect(table).toContainText("3 KB");
		expect(fake.commands.filter((entry: { line: string }) => /\bFETCH\b/i.test(entry.line))).toHaveLength(1);
	} finally {
		await fake.close();
	}
});

test("the 70% warning uses the measured sizes instead of a default per message", async ({ page }) => {
	// 20 tiny messages: the default estimate (24 KB each) crosses 70% of the limit, their real size does not.
	await page.route(/\/api\/import\/estimate/, (route) =>
		route.continue({
			headers: { ...route.request().headers(), [SIZE_HEADER]: `used=${7 * GB - 100_000};limit=${10 * GB}` },
		}),
	);
	const fake = await startFakeImap({
		authPlain: true,
		statusSize: true,
		folders: { INBOX: Array.from({ length: 20 }, (_, index) => sampleMessage(index + 1)) },
	});
	try {
		await showFolders(page, fake.port);
		const totals = page.getByTestId("import-size-total");
		await expect(totals.locator('[data-total="database"]')).toContainText("Adds to the database");
		await expect(page.getByTestId("import-size-notice")).toHaveCount(0);
		// Without sizes (the one-folder form knows only a message limit) the same database is above 70%.
		await chooseOption(page.locator("#imap-mode"), "folder");
		await page.getByLabel("Import all messages (newest first)").uncheck();
		await page.locator("#imap-limit").fill("20");
		await expect(page.getByTestId("import-size-notice")).toContainText("above 70%");
	} finally {
		await fake.close();
	}
});
