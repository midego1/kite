import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

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
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { FileBucket } = await load("filebucket");

const DAY_MS = 86_400_000;
const owner = { id: "owner", role: "user", isPrimaryAdmin: false };

let bucketCount = 0;
async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
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

let messageCount = 0;
/** A received message with a sanitized HTML body (one remote image) and its raw mail in the bucket. */
async function insertMessage(db, env, { mailboxId = "mailbox-a", vendor = "Hosting Co" } = {}) {
	const id = `message-${++messageCount}`;
	const rawKey = `raw/${id}`;
	const seconds = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
	db.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, html_body, text_body, raw_r2_key, status, created_at)
			 VALUES (?, 'owner', ?, 'inbound', ?, 'me@example.com', ?, ?, ?, ?, 'received', ?)`,
		)
		.run(
			id,
			mailboxId,
			`${vendor} <billing@hosting.example>`,
			`Invoice from ${vendor}`,
			`<p>Amount due <b>€120.00</b></p><img src="https://track.example/pixel.gif">`,
			`Amount due €120.00`,
			rawKey,
			seconds,
		);
	await env.BUCKET.put(
		rawKey,
		new TextEncoder().encode(`From: billing@hosting.example\r\nSubject: Invoice\r\n\r\nAmount due 120.00\r\n`),
	);
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
function insertPayment(db, { mailboxId = "mailbox-a", messageId, vendor = "Hosting Co", attachmentId = null }) {
	const id = `payment-${++paymentCount}`;
	const seconds = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
	db.db
		.prepare(
			`INSERT INTO finance_payments
			 (id, user_id, mailbox_id, message_id, attachment_id, vendor, vendor_key, doc_type, status, amount_minor, currency, document_at, source, created_at, updated_at)
			 VALUES (?, 'owner', ?, ?, ?, ?, ?, 'invoice', 'open', 12000, 'EUR', ?, 'auto', ?, ?)`,
		)
		.run(
			id,
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

test("files a payment's mail into Drive (eml, html, pdf) and is idempotent on rescan", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });

	const first = await sweepReceipts();
	assert.equal(first.filed, 1);

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
	const second = await sweepReceipts();
	assert.equal(second.filed, 0);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_receipts WHERE source_id = ?").get(paymentId).n, 1);
	assert.equal(driveFolderChildren(db, yearFolder.id).length, 3, "no duplicate files from the second sweep");
	assert.deepEqual(await filedSourceIds("owner", "finance_payments"), new Set([paymentId]));
});

test("a payment with a receipt attachment also copies the attachment, keeping its extension", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const attachmentId = await insertAttachment(db, env, messageId, { filename: "invoice-9f25.pdf" });
	const paymentId = insertPayment(db, { messageId, attachmentId });

	assert.equal((await sweepReceipts()).filed, 1);
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

test("“Keep receipts” off for the owner skips filing until turned back on", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const paymentId = insertPayment(db, { messageId });

	assert.equal(await receiptsEnabledFor("owner"), true, "on by default");
	await setReceiptsEnabled("owner", false);
	assert.equal((await sweepReceipts()).filed, 0);
	assert.equal(receiptRow(db, paymentId), undefined);

	await setReceiptsEnabled("owner", true);
	assert.equal((await sweepReceipts()).filed, 1);
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

	assert.equal((await sweepReceipts()).filed, 0);
	assert.equal(
		receiptRow(db, paymentId),
		undefined,
		"no row at all while Drive is off, so it is retried once Drive is back on",
	);

	db.db.exec("UPDATE module_settings SET enabled = 1 WHERE module_id = 'drive'");
	clearModuleStateCache();
	assert.equal((await sweepReceipts()).filed, 1);
});

test("a payment from a mailbox with AI off is never filed", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env, { mailboxId: "mailbox-noai" });
	const paymentId = insertPayment(db, { mailboxId: "mailbox-noai", messageId });

	assert.equal((await sweepReceipts()).filed, 0);
	assert.equal(receiptRow(db, paymentId), undefined);
	// Running the sweep again must not somehow pick it up either: it stays excluded every tick.
	assert.equal((await sweepReceipts()).filed, 0);
});

test("receiptsDeleteGuard refuses removing a filed row unless acknowledged, and allows one with no Drive copy", async (t) => {
	const { db, env } = await setup(t);
	const messageId = await insertMessage(db, env);
	const filedId = insertPayment(db, { messageId });
	const unfiledId = insertPayment(db, { messageId: null });
	await sweepReceipts();
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
