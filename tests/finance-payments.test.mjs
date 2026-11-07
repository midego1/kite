import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-payments-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		invoke: join(root, "src/lib/modules/invoke.ts"),
		capability: join(root, "src/lib/modules/capability-utils.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		scan: join(root, "src/lib/finance/payment-scan.ts"),
		views: join(root, "src/lib/finance/payment-views.ts"),
		manual: join(root, "src/lib/finance/manual-payments.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
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
const { invokeCapability } = await load("invoke");
const { buildCallContext } = await load("capability");
const { clearModuleStateCache } = await load("state");
const { undoAgentAction } = await load("execute");
const { startScan, scanPayments } = await load("scan");
const { listPaymentsView, senderOf } = await load("views");
const { patchPayment, removePayment } = await load("manual");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY_MS = 86_400_000;
const AUTH_PASSED = JSON.stringify([{ id: "dmarc_passed" }]);
const owner = { id: "owner", role: "user", isPrimaryAdmin: false, timeZone: "UTC", email: "owner@example.com" };
const viewOf = (account) => ({ userId: account.id, role: account.role, isPrimaryAdmin: false, timeZone: "UTC" });

const STRIPE = {
	from: "Stripe <receipts+acct_1AbCdEfGhIjKlMn@stripe.com>",
	subject: "Your Kestrel Atlas receipt [#1114-6093]",
	body: "Kestrel Atlas\nReceipt #1114-6093\n\nAmount paid\n$500.00\n\nDate paid\nNov 2, 2026\n\nSummary\nKestrel Atlas signup fee $500.00",
};
const INVOICE = {
	from: "Hosting Co <invoices@hosting.example>",
	subject: "Invoice INV-2041 from Hosting Co",
	body: "Amount due: €120.00\nInvoice date: 28 Oct 2026",
};
const MARKETING = {
	from: "Shop <news@shop.example>",
	subject: "Black Friday: 40% off everything",
	body: "Shop now! Jackets from €49.99.",
};

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'UTC', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'me', 'personal', 1),
			('mailbox-noai', 'owner', 'domain-1', 'private', 'personal', 2),
			('mailbox-off', 'owner', 'domain-1', 'old', 'personal', 3);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES
			('mailbox-a', 1, 'suggest', 'owner', '{}', 1),
			('mailbox-noai', 1, 'suggest', 'owner', '{}', 1),
			('mailbox-off', 1, 'off', 'owner', '{}', 1);
		UPDATE mailbox_agent_settings SET ai_disabled = 1 WHERE mailbox_id = 'mailbox-noai';
		UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1;
	`);
	const sent = [];
	const env = {
		DB: db,
		OUTBOUND_QUEUE: { send: async () => undefined },
		AGENT_QUEUE: { send: async (message) => void sent.push(message) },
	};
	globalThis.__kiteNodeEnv = env;
	clearModuleStateCache();
	return { db, env, sent };
}

let counter = 0;
function insertMessage(
	db,
	mail,
	{ mailboxId = "mailbox-a", status = "received", daysAgo = 1, signals = AUTH_PASSED } = {},
) {
	const id = `message-${++counter}`;
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_signals, created_at) VALUES (?, 'owner', ?, 'inbound', ?, 'me@example.com', ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			mailboxId,
			mail.from,
			mail.subject,
			mail.body,
			status,
			signals,
			Math.floor((Date.now() - daysAgo * DAY_MS) / 1000),
		);
	return id;
}

function stepInput(messageId, mail, facts = {}, { mailboxId = "mailbox-a", messageIdHeader = null } = {}) {
	return {
		message: {
			id: messageId,
			mailboxId,
			from: mail.from,
			fromName: /^([^<]+)</.exec(mail.from)?.[1].trim() ?? null,
			subject: mail.subject,
			receivedAt: new Date(Date.UTC(2026, 10, 3, 10)).toISOString(),
			textExcerpt: mail.body,
		},
		facts: {
			authPassed: true,
			bulk: false,
			knownContact: false,
			phishing: [],
			automatic: true,
			noReply: false,
			list: false,
			spam: false,
			muted: false,
			...facts,
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null, messageId: messageIdHeader },
		attachments: [],
		model: null,
	};
}

const stepContext = () =>
	buildCallContext({
		trigger: "auto_read",
		viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
		timeZone: "UTC",
		mailboxIds: ["mailbox-a"],
		grants: ["finance.read", "finance.write"],
	});
const cronContext = () =>
	buildCallContext({ trigger: "cron", viewer: null, grants: ["finance.read", "finance.write"] });

async function recordStep(messageId, mail, facts, options) {
	const ctx = buildCallContext({
		trigger: "auto_read",
		viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
		timeZone: "UTC",
		mailboxIds: [options?.mailboxId ?? "mailbox-a"],
		grants: ["finance.read", "finance.write"],
	});
	const result = await invokeCapability("finance", "recordPayment", stepInput(messageId, mail, facts, options), ctx);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.output, { suggestions: [] }, "the step never offers a card");
}

const rows = (db) =>
	db.db
		.prepare(
			"SELECT vendor, doc_type, status, amount_minor, currency, source, message_id FROM finance_payments ORDER BY created_at, rowid",
		)
		.all();

test("the step records a receipt once, without a card, and a removed row is never recorded again", async (t) => {
	const { db } = await setup(t);
	const messageId = insertMessage(db, STRIPE);
	await recordStep(messageId, STRIPE);
	await recordStep(messageId, STRIPE);
	assert.deepEqual(rows(db), [
		{
			vendor: "Kestrel Atlas",
			doc_type: "payment",
			status: "paid",
			amount_minor: 50_000,
			currency: "USD",
			source: "auto",
			message_id: messageId,
		},
	]);
	const [{ id }] = db.db.prepare("SELECT id FROM finance_payments").all();
	const removed = await removePayment(owner, id);
	assert.equal(removed.status, 200, JSON.stringify(removed.body));
	await recordStep(messageId, STRIPE);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_payments").get().n, 1, "the tombstone stays");
	assert.deepEqual((await listPaymentsView(viewOf(owner))).payments, []);

	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, removed.body.actionId);
	const [shown] = (await listPaymentsView(viewOf(owner))).payments;
	assert.equal(shown.vendor, "Kestrel Atlas");
});

test("phishing, spam, muted and marketing mail record nothing", async (t) => {
	const { db } = await setup(t);
	await recordStep(insertMessage(db, STRIPE), STRIPE, { phishing: ["lookalike_domain"] });
	await recordStep(insertMessage(db, STRIPE), STRIPE, { spam: true });
	await recordStep(insertMessage(db, STRIPE), STRIPE, { muted: true });
	await recordStep(insertMessage(db, MARKETING), MARKETING);
	assert.deepEqual(rows(db), []);
});

test("a tracked subscription's mail goes to its ledger, and a ledger document hides the payment row", async (t) => {
	const { db } = await setup(t);
	db.db
		.exec(`INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, status, created_at, updated_at)
		VALUES ('sub-host', 'owner', 'mailbox-a', 'Hosting Co', 'hosting.example', 'active', 1, 1)`);
	await recordStep(insertMessage(db, INVOICE), INVOICE);
	assert.deepEqual(rows(db), [], "a tracked vendor records nothing here");

	const stripeId = insertMessage(db, STRIPE);
	await recordStep(stripeId, STRIPE);
	// The user then tracks Kestrel Atlas from the same receipt: the document moves to that ledger.
	db.db
		.exec(`INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, status, created_at, updated_at)
		VALUES ('sub-atlas', 'owner', 'mailbox-a', 'Kestrel Atlas', 'stripe.com:kestrel-atlas', 'active', 1, 1)`);
	db.db
		.prepare(
			"INSERT INTO finance_charges (id, subscription_id, user_id, message_id, doc_type, amount_minor, currency, document_at, created_at) VALUES ('fdoc-1', 'sub-atlas', 'owner', ?, 'payment', 50000, 'USD', ?, 1)",
		)
		.run(stripeId, Math.floor(Date.UTC(2026, 10, 2) / 1000));
	const view = await listPaymentsView(viewOf(owner));
	assert.deepEqual(
		view.payments.map((item) => [item.source, item.vendor, item.amount.minor, item.subscriptionId]),
		[["subscription", "Kestrel Atlas", 50_000, "sub-atlas"]],
		"listed once, as the subscription's document",
	);
	assert.deepEqual(view.months, [
		{ month: "2026-11", currency: "USD", paidMinor: 50_000, refundedMinor: 0, openMinor: 0 },
	]);
});

test("a correction is an audited write with Undo", async (t) => {
	const { db } = await setup(t);
	await recordStep(insertMessage(db, INVOICE), INVOICE);
	const [{ id }] = db.db.prepare("SELECT id FROM finance_payments").all();
	const changed = await patchPayment(owner, id, { fields: { status: "paid", amountMinor: 11_900 } });
	assert.equal(changed.status, 200, JSON.stringify(changed.body));
	assert.deepEqual([changed.body.payment.status, changed.body.payment.amount.minor], ["paid", 11_900]);
	const [action] = db.db.prepare("SELECT action, status, mailbox_id FROM agent_actions").all();
	assert.deepEqual(action, { action: "update_payment", status: "applied", mailbox_id: "mailbox-a" });
	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, changed.body.actionId);
	assert.deepEqual(db.db.prepare("SELECT status, amount_minor FROM finance_payments").get(), {
		status: "open",
		amount_minor: 12_000,
	});
	// A renamed vendor pairs only with its own rows; undo puts the sender's key back.
	const renamed = await patchPayment(owner, id, { fields: { vendor: "Hosting Group" } });
	assert.equal(db.db.prepare("SELECT vendor_key FROM finance_payments").get().vendor_key, "manual:hosting-group");
	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, renamed.body.actionId);
	assert.deepEqual(db.db.prepare("SELECT vendor, vendor_key FROM finance_payments").get(), {
		vendor: "Hosting Co",
		vendor_key: "hosting.example",
	});
	// Only the removal that hid the row owns it: a second one is refused.
	assert.equal((await removePayment(owner, id)).status, 200);
	assert.equal((await removePayment(owner, id)).status, 404, "a removed row is gone for the routes");
	const second = await invokeCapability(
		"finance",
		"removePayment",
		{
			op: "execute",
			actionId: "aact_second",
			suggestion: { id: null, messageId: null, mailboxId: "mailbox-a" },
			input: { paymentId: id },
		},
		stepContext(),
	);
	assert.equal(second.output.refused?.status, 409);
	const broken = await invokeCapability(
		"finance",
		"removePayment",
		{ op: "undo", actionId: "aact_broken", inverse: { inverse: { nothing: true } } },
		stepContext(),
	);
	assert.equal(broken.output.refused?.status, 409, "an undo with nothing to put back is refused");
	assert.equal((await patchPayment(owner, "fpay_missing", { fields: { status: "paid" } })).status, 404);
	assert.equal((await patchPayment(owner, id, { fields: { status: "refunded", extra: 1 } })).status, 400);
});

test("the 90-day scan reads mailboxes with automatic reading and AI on, skips spam and held mail, and resumes", async (t) => {
	const { db, sent } = await setup(t);
	const recorded = insertMessage(db, STRIPE, { daysAgo: 30 });
	const invoice = insertMessage(db, INVOICE, { daysAgo: 10, status: "archived" });
	insertMessage(db, STRIPE, { mailboxId: "mailbox-noai", daysAgo: 5 });
	insertMessage(db, STRIPE, { mailboxId: "mailbox-off", daysAgo: 5 });
	insertMessage(db, STRIPE, { status: "spam", daysAgo: 4 });
	insertMessage(db, STRIPE, { status: "screening", daysAgo: 3 });
	insertMessage(db, STRIPE, { daysAgo: 120 });
	insertMessage(db, STRIPE, { daysAgo: 2, signals: null });
	for (let index = 0; index < 5; index++) insertMessage(db, { ...MARKETING, subject: `Weekly news ${index}` });

	const scan = await startScan("owner");
	assert.equal(scan.status, "running");
	assert.deepEqual(sent, [{ kind: "finance.scan", userId: "owner" }]);
	for (let run = 0; run < 5 && (await listPaymentsView(viewOf(owner))).scan.status === "running"; run++)
		await scanPayments({ kind: "finance.scan", userId: "owner" }, cronContext());
	const view = await listPaymentsView(viewOf(owner));
	assert.equal(view.scan.status, "done");
	assert.equal(view.scan.recorded, 2);
	assert.deepEqual(
		rows(db).map((row) => [row.message_id, row.source]),
		[
			[recorded, "scan"],
			[invoice, "scan"],
		],
		"only the eligible, authenticated, recent mail",
	);
	// A finished scan starts again from the beginning and writes nothing twice.
	await startScan("owner");
	await scanPayments({ kind: "finance.scan", userId: "owner" }, cronContext());
	assert.equal(rows(db).length, 2);
});

test("before migration 0094 the step and the view report the pending update", async (t) => {
	const { db } = await setup(t);
	db.db.exec("DROP TABLE finance_payment_scans; DROP TABLE finance_payments;");
	const result = await invokeCapability("finance", "recordPayment", stepInput("message-x", STRIPE), stepContext());
	assert.deepEqual(result.output, { suggestions: [], skipped: "migration_pending" });
	assert.deepEqual(await listPaymentsView(viewOf(owner)), {
		truncated: false,
		payments: [],
		months: [],
		scan: null,
		migrationPending: true,
	});
});

test("review probe: a reminder of a recorded invoice and its payment leave nothing open and count once", async (t) => {
	const { db } = await setup(t);
	const bill = { ...INVOICE, subject: "Invoice INV-2041 from Hosting Co", body: "Amount due: €100.00" };
	const reminder = {
		...INVOICE,
		subject: "Reminder: invoice INV-2041 has not been paid",
		body: "Amount due: €100.00",
	};
	const receipt = {
		...INVOICE,
		subject: "Payment received for invoice INV-2041",
		body: "Thank you for your payment.\nAmount paid: €100.00",
	};
	await recordStep(insertMessage(db, bill), bill);
	await recordStep(insertMessage(db, reminder), reminder);
	assert.deepEqual(
		rows(db).map((row) => [row.doc_type, row.status]),
		[["invoice", "open"]],
		"the reminder repeats the invoice's number",
	);
	await recordStep(insertMessage(db, receipt), receipt);
	const view = await listPaymentsView(viewOf(owner));
	assert.deepEqual(view.payments.map((item) => [item.docType, item.status]).sort(), [
		["invoice", "paid"],
		["payment", "paid"],
	]);
	assert.deepEqual(view.months, [
		{ month: "2026-11", currency: "EUR", paidMinor: 10_000, refundedMinor: 0, openMinor: 0 },
	]);
});

test("review probe: one receipt delivered to two mailboxes the user reviews is recorded once", async (t) => {
	const { db } = await setup(t);
	const header = "<receipt-1114-6093@mail.stripe.example>";
	await recordStep(insertMessage(db, STRIPE), STRIPE, {}, { messageIdHeader: header });
	const copy = insertMessage(db, STRIPE, { mailboxId: "mailbox-off" });
	await recordStep(copy, STRIPE, {}, { mailboxId: "mailbox-off", messageIdHeader: header.toUpperCase() });
	assert.equal(rows(db).length, 1);
	// A forwarded copy from the user's own address book counts nothing either.
	const forwarded = { ...STRIPE, from: "Me <me.example@gmail.com>", subject: `Fwd: ${STRIPE.subject}` };
	await recordStep(insertMessage(db, forwarded), forwarded);
	assert.equal(rows(db).length, 1);
});

test("review probe: the scan follows the live gate and the Screener", async (t) => {
	const { db, env } = await setup(t);
	const own = { ...INVOICE, from: "Me Freelance <me@example.com>", subject: "Invoice INV-7001 from Me Freelance" };
	const bounce = { ...INVOICE, from: "MAILER-DAEMON@relay.example.net", subject: "Invoice INV-7002 undeliverable" };
	const undecided = { ...INVOICE, from: "Newco <invoices@newco.example>", subject: "Invoice INV-7003 from Newco" };
	const approved = { ...INVOICE, from: "Oldco <invoices@oldco.example>", subject: "Invoice INV-7004 from Oldco" };
	for (const mail of [own, bounce, undecided, approved]) insertMessage(db, mail, { daysAgo: 5 });
	db.db.exec(`
		INSERT INTO screener_settings (mailbox_id, enabled, mode, created_at, updated_at) VALUES ('mailbox-a', 1, 'inbox', 1, 1);
		INSERT INTO screener_senders (id, mailbox_id, address, decision, created_at, updated_at)
			VALUES ('ss-1', 'mailbox-a', 'invoices@oldco.example', 'approved', 1, 1);
	`);
	// A message whose raw headers cannot be read is skipped; the scan moves on.
	const broken = insertMessage(db, { ...INVOICE, subject: "Invoice INV-7005 from Hosting Co" }, { daysAgo: 4 });
	db.db.prepare("UPDATE messages SET raw_r2_key = 'raw/broken' WHERE id = ?").run(broken);
	env.BUCKET = {
		get: async (key) => {
			if (key === "raw/broken") throw new Error("storage unavailable");
			return null;
		},
	};
	await startScan("owner");
	for (let run = 0; run < 5 && (await listPaymentsView(viewOf(owner))).scan.status === "running"; run++)
		await scanPayments({ kind: "finance.scan", userId: "owner" }, cronContext());
	const view = await listPaymentsView(viewOf(owner));
	assert.equal(view.scan.status, "done");
	// The unreadable message is from an undecided sender in this Inbox-mode mailbox, so the gate leaves it out unread.
	assert.equal(view.scan.skipped, 0);
	assert.deepEqual(
		rows(db).map((row) => row.vendor),
		["Oldco"],
		"own address, bounce sender, undecided Inbox-mode sender and the unreadable message are left out",
	);
});

test("the row names where a payment's mail came from", () => {
	assert.equal(senderOf("attacker-example.test"), "attacker-example.test");
	assert.equal(senderOf("stripe.com:kestrel-atlas"), "stripe.com");
	assert.equal(senderOf("mail:friend.example@gmail.com"), "friend.example@gmail.com");
	assert.equal(senderOf("manual:hosting-group"), null);
});

test("review 2: a page the gate leaves out entirely does not hold the scan", async (t) => {
	const { db } = await setup(t);
	const own = { ...INVOICE, from: "Me <me@example.com>", subject: "Invoice copy" };
	for (let index = 0; index < 205; index++)
		insertMessage(db, { ...own, subject: `Invoice INV-${8000 + index} copy` }, { daysAgo: 10 });
	const real = insertMessage(db, { ...INVOICE, subject: "Invoice INV-9001 from Hosting Co" }, { daysAgo: 2 });
	await startScan("owner");
	for (let run = 0; run < 6 && (await listPaymentsView(viewOf(owner))).scan.status === "running"; run++)
		await scanPayments({ kind: "finance.scan", userId: "owner" }, cronContext());
	const { scan } = await listPaymentsView(viewOf(owner));
	assert.equal(scan.status, "done");
	assert.equal(scan.scanned, 206, "every row read counts, also the ones the gate left out");
	assert.deepEqual(
		rows(db).map((row) => row.message_id),
		[real],
	);
});

test("review 2: two partial refunds under one order number are two rows", async (t) => {
	const { db } = await setup(t);
	const refund = (amount) => ({
		from: "Shop <support@shop.example>",
		subject: "Your refund for order #A12345",
		body: `We refunded €${amount} to your card. Order #A12345.`,
	});
	await recordStep(insertMessage(db, refund("20.00")), refund("20.00"));
	await recordStep(insertMessage(db, refund("15.00")), refund("15.00"));
	await recordStep(insertMessage(db, refund("15.00")), refund("15.00"));
	assert.deepEqual(
		rows(db).map((row) => [row.doc_type, row.amount_minor]),
		[
			["refund", 2_000],
			["refund", 1_500],
		],
		"the same refund mailed twice still counts once",
	);
});

test("review 2: a message that fails once is retried, one that keeps failing is counted as skipped", async (t) => {
	const { db, env } = await setup(t);
	const flaky = insertMessage(db, { ...INVOICE, subject: "Invoice INV-7101 from Hosting Co" }, { daysAgo: 3 });
	const broken = insertMessage(db, { ...INVOICE, subject: "Invoice INV-7102 from Hosting Co" }, { daysAgo: 2 });
	db.db.prepare("UPDATE messages SET raw_r2_key = 'raw/' || id WHERE id IN (?, ?)").run(flaky, broken);
	let flakyCalls = 0;
	env.BUCKET = {
		get: async (key) => {
			if (key === `raw/${flaky}` && flakyCalls++ === 0) throw new Error("storage hiccup");
			if (key === `raw/${broken}`) throw new Error("storage unavailable");
			return null;
		},
	};
	await startScan("owner");
	for (let run = 0; run < 5 && (await listPaymentsView(viewOf(owner))).scan.status === "running"; run++)
		await scanPayments({ kind: "finance.scan", userId: "owner" }, cronContext());
	const { scan } = await listPaymentsView(viewOf(owner));
	assert.deepEqual([scan.status, scan.recorded, scan.skipped], ["done", 1, 1]);
	assert.deepEqual(
		rows(db).map((row) => row.message_id),
		[flaky],
	);
});

test("review 2: a database with an earlier draft of migration 0094 reads as an update pending", async (t) => {
	const { db } = await setup(t);
	db.db.exec(`DROP TABLE finance_payments;
		CREATE TABLE finance_payments (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, message_id text);`);
	assert.equal((await listPaymentsView(viewOf(owner))).migrationPending, true);
	const result = await invokeCapability("finance", "recordPayment", stepInput("message-x", STRIPE), stepContext());
	assert.deepEqual(result.output, { suggestions: [], skipped: "migration_pending" });
});
