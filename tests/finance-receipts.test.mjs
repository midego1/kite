import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-receipts-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries; building
// invoke.ts for real (not through the module-registry stub) pulls in every builtin module's server.ts, the
// same wiring Money Watch uses in production to reach Drive through the module host.
await build({
	entryPoints: {
		invoke: join(root, "src/lib/modules/invoke.ts"),
		capability: join(root, "src/lib/modules/capability-utils.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		receipts: join(root, "src/lib/finance/receipts.ts"),
		settings: join(root, "src/lib/finance/receipt-settings.ts"),
		guard: join(root, "src/lib/finance/receipt-delete-guard.ts"),
		backfill: join(root, "src/lib/finance/receipt-backfill.ts"),
		driveReceipts: join(root, "src/lib/drive/receipts.ts"),
		views: join(root, "src/lib/finance/views.ts"),
		paymentViews: join(root, "src/lib/finance/payment-views.ts"),
		manual: join(root, "src/lib/finance/manual.ts"),
		manualPayments: join(root, "src/lib/finance/manual-payments.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		filebucket: join(root, "server/runtime/file-bucket.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: {
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
		"next/server": "next/server.js",
		"next/headers": "next/headers.js",
		"next/navigation": "next/navigation.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
await load("invoke"); // binds moduleHost.invoke to the real registry as a side effect
const { clearModuleStateCache } = await load("state");
const { fileOneReceipt, receiptCandidates, filedSourceIds, sweepReceipts } = await load("receipts");
const { receiptsEnabledFor, setReceiptsEnabled } = await load("settings");
const { receiptsDeleteGuard, RECEIPTS_IN_DRIVE_ERROR } = await load("guard");
const { startReceiptBackfill, ownerBackfill, backfillReceipts, resumeReceiptBackfills } = await load("backfill");
const { ensureFolderPath } = await load("driveReceipts");
const { listSubscriptionsView } = await load("views");
const { listPaymentsView } = await load("paymentViews");
const { removeSubscription } = await load("manual");
const { removePayment } = await load("manualPayments");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { FileBucket } = await load("filebucket");

const DAY_MS = 86_400_000;
const owner = { id: "owner", role: "user", isPrimaryAdmin: false };

let bucketCount = 0;
async function setup(t, { migrationsBefore } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	const migrationsDir =
		migrationsBefore === undefined ? join(root, "drizzle/migrations") : copyMigrationsBefore(outDir, migrationsBefore);
	await applyMigrations(db, migrationsDir);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'me', 'personal', 1),
			('mailbox-noai', 'owner', 'domain-1', 'private', 'personal', 2);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES
			('mailbox-a', 1, 'suggest', 'owner', '{}', 1),
			('mailbox-noai', 1, 'suggest', 'owner', '{}', 1);
		UPDATE mailbox_agent_settings SET ai_disabled = 1 WHERE mailbox_id = 'mailbox-noai';
	`);
	const bucket = new FileBucket(join(outDir, `bucket-${++bucketCount}`));
	const env = { DB: db, BUCKET: bucket };
	globalThis.__kiteNodeEnv = env;
	clearModuleStateCache();
	return { db, env };
}

const RAW_MESSAGE_TEXT = `From: billing@hosting.example\r\nSubject: Invoice\r\n\r\nAmount due 120.00\r\n`;
const RAW_MESSAGE_BYTES = new TextEncoder().encode(RAW_MESSAGE_TEXT).byteLength;

let messageCount = 0;
/** A received message with a sanitized HTML body (one remote image) and its raw mail in the bucket. */
async function insertMessage(db, env, { mailboxId = "mailbox-a", vendor = "Hosting Co", userId = "owner" } = {}) {
	const id = `message-${++messageCount}`;
	const rawKey = `raw/${id}`;
	const seconds = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
	db.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, html_body, text_body, raw_r2_key, status, created_at)
			 VALUES (?, ?, ?, 'inbound', ?, 'me@example.com', ?, ?, ?, ?, 'received', ?)`,
		)
		.run(
			id,
			userId,
			mailboxId,
			`${vendor} <billing@hosting.example>`,
			`Invoice from ${vendor}`,
			`<p>Amount due <b>€120.00</b></p><img src="https://track.example/pixel.gif">`,
			`Amount due €120.00`,
			rawKey,
			seconds,
		);
	await env.BUCKET.put(rawKey, new TextEncoder().encode(RAW_MESSAGE_TEXT));
	return id;
}

let attachmentCount = 0;
/** An 'object'-storage attachment, its bytes actually in the bucket, as a receipt PDF the row can reference. */
async function insertAttachment(
	db,
	env,
	messageId,
	{ filename = "receipt.pdf", contentType = "application/pdf" } = {},
) {
	const id = `attachment-${++attachmentCount}`;
	const key = `attachments/${messageId}/${id}`;
	const bytes = new TextEncoder().encode("%PDF-1.4");
	await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
	db.db
		.prepare(
			`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, storage, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'object', ?)`,
		)
		.run(id, messageId, filename, contentType, bytes.byteLength, key, Math.floor(Date.now() / 1000));
	return id;
}

let paymentCount = 0;
function insertPayment(
	db,
	{
		mailboxId = "mailbox-a",
		messageId,
		vendor = "Hosting Co",
		attachmentId = null,
		createdAtSeconds,
		userId = "owner",
	} = {},
) {
	const id = `payment-${++paymentCount}`;
	const seconds = createdAtSeconds ?? Math.floor((Date.now() - 2 * DAY_MS) / 1000);
	db.db
		.prepare(
			`INSERT INTO finance_payments
			 (id, user_id, mailbox_id, message_id, attachment_id, vendor, vendor_key, doc_type, status, amount_minor, currency, document_at, source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'invoice', 'open', 12000, 'EUR', ?, 'auto', ?, ?)`,
		)
		.run(
			id,
			userId,
			mailboxId,
			messageId,
			attachmentId,
			vendor,
			vendor.toLowerCase().replace(/\s+/g, "-"),
			seconds,
			seconds,
			seconds,
		);
	return id;
}

function driveFolderChildren(db, parentId) {
	return db.db
		.prepare(
			parentId === null
				? "SELECT id, kind, name FROM drive_items WHERE parent_id IS NULL AND owner_id = 'owner' ORDER BY name"
				: "SELECT id, kind, name FROM drive_items WHERE parent_id = ? AND owner_id = 'owner' ORDER BY name",
		)
		.all(...(parentId === null ? [] : [parentId]));
}

function receiptRow(db, sourceId) {
	return db.db.prepare("SELECT * FROM finance_receipts WHERE source_id = ?").get(sourceId);
}

/** Files every eligible candidate for one owner directly, the same machinery the backfill uses (no sweep floor):
 * what most of these tests actually exercise is `fileOneReceipt`'s own behaviour, not the sweep's floor. */
async function fileEligible(userId, limit = 100) {
	let filed = 0;
	for (const candidate of await receiptCandidates(limit, userId)) {
		if (await fileOneReceipt(candidate)) filed += 1;
	}
	return filed;
}

test("files a payment's mail into Drive (eml, html, pdf) and is idempotent on rescan", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });

	assert.equal(await fileEligible("owner"), 1);

	const row = receiptRow(db, paymentId);
	assert.equal(row.status, "done");
	assert.ok(row.eml_file_id);
	assert.ok(row.html_file_id);
	assert.ok(row.pdf_file_id);
	assert.equal(row.attachment_file_id, null, "no attachment was given");

	const year = new Date().getUTCFullYear().toString();
	const moneyWatch = driveFolderChildren(db, null).find((item) => item.name === "Money Watch");
	assert.ok(moneyWatch);
	const receiptsFolder = driveFolderChildren(db, moneyWatch.id).find((item) => item.name === "Receipts");
	assert.ok(receiptsFolder);
	const yearFolder = driveFolderChildren(db, receiptsFolder.id).find((item) => item.name === year);
	assert.ok(yearFolder);
	const files = driveFolderChildren(db, yearFolder.id);
	assert.equal(files.filter((item) => item.kind === "file").length, 3, "eml, html and pdf");

	// Rescanning (the sweep runs every tick) must not refile or duplicate the folder tree.
	assert.equal(await fileEligible("owner"), 0);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_receipts WHERE source_id = ?").get(paymentId).n, 1);
	assert.equal(driveFolderChildren(db, yearFolder.id).length, 3, "no duplicate files from the second sweep");
	assert.deepEqual(await filedSourceIds("owner", "finance_payments"), new Set([paymentId]));
});

test("a payment with a receipt attachment also copies the attachment, keeping its extension", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const attachmentId = await insertAttachment(db, env, messageId, { filename: "invoice-9f25.pdf" });
	const paymentId = insertPayment(db, { messageId, attachmentId });

	assert.equal(await fileEligible("owner"), 1);
	const row = receiptRow(db, paymentId);
	assert.equal(row.status, "done");
	assert.ok(row.attachment_file_id, "the attachment was copied independently of the eml/html/pdf");

	const attachmentItem = db.db
		.prepare("SELECT name, content_type FROM drive_items WHERE id = ?")
		.get(row.attachment_file_id);
	assert.ok(attachmentItem.name.endsWith(".pdf"), `expected a .pdf name, got ${attachmentItem.name}`);
	assert.equal(attachmentItem.content_type, "application/pdf");
});

test("ensureFolderPath reuses an existing folder instead of creating a second one with the same name", async (t) => {
	const { db, env } = await setup(t);
	const first = await ensureFolderPath(env, "owner", ["Money Watch", "Receipts", "2026"]);
	const second = await ensureFolderPath(env, "owner", ["Money Watch", "Receipts", "2026"]);
	assert.equal(first, second);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM drive_items WHERE owner_id = 'owner'").get().n, 3);
});

test("two calls racing to create the same folder path end up with exactly one folder of each name, not two (re-read and merge)", async (t) => {
	const { db, env } = await setup(t);
	const [first, second] = await Promise.all([
		ensureFolderPath(env, "owner", ["Money Watch", "Receipts", "2026"]),
		ensureFolderPath(env, "owner", ["Money Watch", "Receipts", "2026"]),
	]);
	assert.equal(first, second, "both calls agree on the same winning folder");
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM drive_items WHERE owner_id = 'owner'").get().n,
		3,
		"one Money Watch, one Receipts, one 2026 — no duplicate from the race",
	);
});

test("“Keep receipts” off for the owner skips filing until turned back on", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });

	assert.equal(await receiptsEnabledFor("owner"), true, "on by default");
	await setReceiptsEnabled("owner", false);
	assert.equal(await fileEligible("owner"), 0);
	assert.equal(receiptRow(db, paymentId), undefined);

	await setReceiptsEnabled("owner", true);
	assert.equal(await fileEligible("owner"), 1);
	assert.equal(receiptRow(db, paymentId).status, "done");
});

test("Drive turned off for the install means no copies, and nothing is recorded as skipped", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });
	db.db.exec(
		"INSERT INTO module_settings (id, module_id, enabled, updated_at, updated_by) VALUES ('ms-drive', 'drive', 0, 1, 'owner')",
	);
	clearModuleStateCache();

	assert.equal(await fileEligible("owner"), 0);
	assert.equal(
		receiptRow(db, paymentId),
		undefined,
		"no row at all while Drive is off, so it is retried once Drive is back on",
	);

	db.db.exec("UPDATE module_settings SET enabled = 1 WHERE module_id = 'drive'");
	clearModuleStateCache();
	assert.equal(await fileEligible("owner"), 1);
});

test("a payment from a mailbox with AI off is never filed", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env, { mailboxId: "mailbox-noai" });
	const paymentId = insertPayment(db, { mailboxId: "mailbox-noai", messageId });

	assert.equal(await fileEligible("owner"), 0);
	assert.equal(receiptRow(db, paymentId), undefined);
	// Running it again must not somehow pick it up either: it stays excluded every tick.
	assert.equal(await fileEligible("owner"), 0);
});

test("receiptsDeleteGuard refuses removing a filed row unless acknowledged, and allows one with no Drive copy", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const filedId = insertPayment(db, { messageId });
	const unfiledId = insertPayment(db, { messageId: null });
	await fileEligible("owner");
	assert.equal(receiptRow(db, filedId).status, "done");

	const refused = await receiptsDeleteGuard("finance_payments", [filedId], false);
	assert.deepEqual(refused, { status: 409, body: { error: RECEIPTS_IN_DRIVE_ERROR, code: "RECEIPTS_IN_DRIVE" } });

	assert.equal(await receiptsDeleteGuard("finance_payments", [filedId], true), null, "acknowledged, so it proceeds");
	assert.equal(
		await receiptsDeleteGuard("finance_payments", [unfiledId], false),
		null,
		"nothing filed, nothing to ask about",
	);
});

test("filedSourceIds and receiptsDeleteGuard answer normally on a database before migration 0101, instead of refusing", async (t) => {
	const { db, env } = await setup(t, { migrationsBefore: 101 });
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });

	assert.deepEqual(
		await filedSourceIds("owner", "finance_payments"),
		new Set(),
		"nothing can be filed yet, which is simply the true answer, not finance_receipts.migrationPending",
	);
	assert.equal(
		await receiptsDeleteGuard("finance_payments", [paymentId], false),
		null,
		"nothing to ask about yet, so the payments tab's own delete keeps working",
	);
});

test("the Subscriptions and Payments views, and their deletes, work before migration 0101 instead of reading as migrationPending", async (t) => {
	const { db, env } = await setup(t, { migrationsBefore: 101 });
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });
	const seconds = Math.floor(Date.now() / 1000);
	db.db
		.prepare(
			`INSERT INTO finance_subscriptions (id, user_id, vendor, vendor_key, status, created_at, updated_at)
			 VALUES ('sub-1', 'owner', 'Hosting Co', 'hosting-co', 'active', ?, ?)`,
		)
		.run(seconds, seconds);
	const viewUser = { userId: "owner", role: "user", isPrimaryAdmin: false, timeZone: "UTC" };
	const financeUser = { id: "owner", email: "owner@example.com", role: "user", isPrimaryAdmin: false, timeZone: "UTC" };

	const subscriptions = await listSubscriptionsView(viewUser, null);
	assert.equal(subscriptions.migrationPending, undefined, "0063/0094 are applied; only Keep receipts (0101) is not");
	assert.deepEqual(
		subscriptions.subscriptions.map((row) => row.id),
		["sub-1"],
	);

	const payments = await listPaymentsView(viewUser);
	assert.equal(payments.migrationPending, undefined);
	assert.deepEqual(
		payments.payments.map((row) => row.id),
		[paymentId],
	);

	const removedSub = await removeSubscription(financeUser, "sub-1");
	assert.equal(removedSub.status, 200, JSON.stringify(removedSub.body));
	const removedPayment = await removePayment(financeUser, paymentId);
	assert.equal(removedPayment.status, 200, JSON.stringify(removedPayment.body));
});

test('"Save receipts for existing payments" runs to completion through the queue, batch by batch', async (t) => {
	const { db, env } = await setup(t);
	const sent = [];
	env.AGENT_QUEUE = { send: async (message) => void sent.push(message) };
	const paymentIds = await Promise.all(
		Array.from({ length: 3 }, async () => insertPayment(db, { messageId: await insertMessage(db, env) })),
	);

	const started = await startReceiptBackfill("owner");
	assert.equal(started.status, "running");
	assert.equal(sent.length, 1);

	let guardRounds = 0;
	while (sent.length > 0 && guardRounds++ < 10) await backfillReceipts(sent.shift());

	const finished = await ownerBackfill("owner");
	assert.equal(finished.status, "done");
	assert.equal(finished.filed, 3);
	for (const id of paymentIds) assert.equal(receiptRow(db, id).status, "done");

	// Starting it again while mail still exists (the resumable backfill action) must not duplicate anything.
	await startReceiptBackfill("owner");
	while (sent.length > 0 && guardRounds++ < 20) await backfillReceipts(sent.shift());
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_receipts").get().n, 3);
});

test("the five-minute safety net resumes a backfill whose run died, with no queue available", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	insertPayment(db, { messageId });
	const old = Math.floor((Date.now() - 10 * 60_000) / 1000);
	db.db
		.prepare(
			`INSERT INTO finance_receipt_backfills (user_id, status, scanned, filed, skipped, lease_until, started_at, updated_at)
			 VALUES ('owner', 'running', 0, 0, 0, NULL, ?, ?)`,
		)
		.run(old, old);

	const result = await resumeReceiptBackfills(null, {});
	assert.equal(result.resumed, 1);
	const row = await ownerBackfill("owner");
	assert.equal(row.status, "done");
	assert.equal(row.filed, 1);
});

test("the automatic sweep only files rows created after the floor it sets on its own first run; an older row needs the explicit backfill", async (t) => {
	const { db, env } = await setup(t);
	const oldMessageId = await insertMessage(db, env);
	const oldPaymentId = insertPayment(db, { messageId: oldMessageId });

	const firstTick = await sweepReceipts();
	assert.equal(firstTick.filed, 0, "the first tick only sets the floor; it never auto-files history");
	assert.equal(receiptRow(db, oldPaymentId), undefined);

	const floor = db.db
		.prepare("SELECT finance_receipts_sweep_since AS since FROM app_settings WHERE id = 'default'")
		.get().since;
	assert.ok(floor, "the floor is set to the time of the first tick");

	const newMessageId = await insertMessage(db, env);
	const newPaymentId = insertPayment(db, { messageId: newMessageId, createdAtSeconds: floor + 5 });

	const secondTick = await sweepReceipts();
	assert.equal(secondTick.filed, 1, "a row created after the floor is swept automatically");
	assert.equal(receiptRow(db, newPaymentId).status, "done");
	assert.equal(receiptRow(db, oldPaymentId), undefined, "the older row is still not auto-filed");

	// Only the explicit backfill (fileEligible uses the same candidate/file path with no floor) reaches it.
	assert.equal(await fileEligible("owner"), 1);
	assert.equal(receiptRow(db, oldPaymentId).status, "done");
});

test("two runs racing to file the same row (a sweep tick and a backfill batch) never both file it, and never duplicate the finance_receipts row or the Drive files", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });
	const [candidate] = await receiptCandidates(10, "owner");
	assert.ok(candidate);

	const [first, second] = await Promise.all([fileOneReceipt(candidate), fileOneReceipt(candidate)]);
	assert.deepEqual([first, second].sort(), [false, true], "exactly one of the two racing attempts actually files it");

	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_receipts WHERE source_id = ?").get(paymentId).n, 1);
	const row = receiptRow(db, paymentId);
	assert.equal(row.status, "done");

	const year = new Date().getUTCFullYear().toString();
	const moneyWatch = driveFolderChildren(db, null).find((item) => item.name === "Money Watch");
	const receiptsFolder = driveFolderChildren(db, moneyWatch.id).find((item) => item.name === "Receipts");
	const yearFolder = driveFolderChildren(db, receiptsFolder.id).find((item) => item.name === year);
	assert.equal(driveFolderChildren(db, yearFolder.id).length, 3, "eml, html and pdf, not six from a double file");
});

test("a claim whose run died (an expired lease) is retried, not stuck forever and not filed twice", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });
	const staleLease = Math.floor((Date.now() - 60_000) / 1000);
	db.db
		.prepare(
			`INSERT INTO finance_receipts (id, user_id, source_table, source_id, message_id, status, lease_until, created_at, updated_at)
			 VALUES ('stuck-claim', 'owner', 'finance_payments', ?, ?, 'pending', ?, ?, ?)`,
		)
		.run(paymentId, messageId, staleLease, staleLease, staleLease);

	assert.equal(
		await fileEligible("owner"),
		1,
		"the expired claim is taken over and completed, not skipped as already claimed",
	);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_receipts WHERE source_id = ?").get(paymentId).n, 1);
	const row = receiptRow(db, paymentId);
	assert.equal(row.id, "stuck-claim", "the same claim row is reused, not replaced by a second one");
	assert.equal(row.status, "done");
});

test("quota filling partway through a row leaves it pending, not done with pieces missing and not a permanent skip; a retry resumes and reuses what already landed", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });
	// Enough quota for the .eml (the first piece attempted) but not for the larger generated HTML copy.
	db.db
		.prepare("INSERT INTO drive_user_quotas (user_id, quota_bytes, updated_at) VALUES ('owner', ?, 1)")
		.run(RAW_MESSAGE_BYTES);

	assert.equal(await fileEligible("owner"), 0, "the row cannot be completed yet");
	let row = receiptRow(db, paymentId);
	assert.equal(row.status, "pending", "left retryable, not recorded as a permanent skip");
	assert.equal(row.html_file_id, null);
	assert.equal(row.pdf_file_id, null);

	const year = new Date().getUTCFullYear().toString();
	const moneyWatch = driveFolderChildren(db, null).find((item) => item.name === "Money Watch");
	const receiptsFolder = driveFolderChildren(db, moneyWatch.id).find((item) => item.name === "Receipts");
	const yearFolder = driveFolderChildren(db, receiptsFolder.id).find((item) => item.name === year);
	const beforeRetry = driveFolderChildren(db, yearFolder.id);
	assert.equal(
		beforeRetry.filter((item) => item.kind === "file").length,
		1,
		"only the .eml landed before quota stopped it",
	);
	const emlId = beforeRetry[0].id;

	db.db.exec("UPDATE drive_user_quotas SET quota_bytes = NULL WHERE user_id = 'owner'");
	// A real retry happens once the claim's lease naturally expires (the next sweep tick or backfill batch, up to
	// five minutes later); simulate that passage of time rather than waiting for it.
	db.db.prepare("UPDATE finance_receipts SET lease_until = 0 WHERE source_id = ?").run(paymentId);
	assert.equal(await fileEligible("owner"), 1, "the retry completes the row");
	row = receiptRow(db, paymentId);
	assert.equal(row.status, "done");
	assert.equal(row.eml_file_id, emlId, "the already-written .eml is reused, not duplicated");
	const afterRetry = driveFolderChildren(db, yearFolder.id);
	assert.equal(afterRetry.filter((item) => item.kind === "file").length, 3, "eml, html and pdf, no duplicate .eml");
});

test("a user whose rows can never be eligible right now does not crowd an owner who is, out of the same tick", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', 'hash', 'Other', 2);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-2', 'other', 'other.example', 'zone-2', 'active', 2);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-other', 'other', 'domain-2', 'me', 'personal', 2);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES ('mailbox-other', 1, 'suggest', 'other', '{}', 2);
	`);
	await setReceiptsEnabled("other", false);

	// Several older, ineligible rows that, without SQL-side filtering, would fill a small per-tick limit forever.
	for (let i = 0; i < 3; i += 1) {
		const otherMessageId = await insertMessage(db, env, { mailboxId: "mailbox-other", userId: "other" });
		insertPayment(db, {
			mailboxId: "mailbox-other",
			messageId: otherMessageId,
			userId: "other",
			createdAtSeconds: 100 + i,
		});
	}
	// A newer, eligible row for "owner".
	const ownerMessageId = await insertMessage(db, env);
	const ownerPaymentId = insertPayment(db, { messageId: ownerMessageId, createdAtSeconds: 1000 });

	const candidates = await receiptCandidates(1);
	assert.deepEqual(
		candidates.map((c) => c.sourceId),
		[ownerPaymentId],
		"the ineligible owner's older rows are excluded from the pool entirely, not merely skipped at filing time",
	);
});
