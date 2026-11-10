import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-purchases-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		invoke: join(root, "src/lib/modules/invoke.ts"),
		capability: join(root, "src/lib/modules/capability-utils.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		views: join(root, "src/lib/finance/payment-views.ts"),
		manual: join(root, "src/lib/finance/manual-payments.ts"),
		step: join(root, "src/lib/finance/payment-step.ts"),
		mcpAuth: join(root, "src/lib/mcp/auth.ts"),
		apiKeys: join(root, "src/lib/api-keys.ts"),
		refs: join(root, "src/lib/modules/record-refs.ts"),
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
// The pure helpers get their own build with source maps, so the coverage gate can measure them.
await build({
	entryPoints: {
		category: join(root, "src/lib/finance/category-utils.ts"),
		csv: join(root, "src/lib/finance/payment-csv-utils.ts"),
		filter: join(root, "src/lib/finance/payment-filter-utils.ts"),
		exportUtils: join(root, "src/lib/finance/payment-export-utils.ts"),
		paymentUtils: join(root, "src/lib/finance/payment-utils.ts"),
		searchUtils: join(root, "src/lib/finance/payment-search-utils.ts"),
	},
	outdir: join(outDir, "utils"),
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	sourcemap: "inline",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const loadUtil = (name) => import(pathToFileURL(join(outDir, "utils", `${name}.mjs`)).href);
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { invokeCapability } = await load("invoke");
const { buildCallContext } = await load("capability");
const { clearModuleStateCache } = await load("state");
const { undoAgentAction } = await load("execute");
const { listPaymentsView, paymentsForExport } = await load("views");
const { patchPayment } = await load("manual");
const { recordPaymentFromInput } = await load("step");
const { authenticateMcpRequest } = await load("mcpAuth");
const { generateApiKey, scopesToJson } = await load("apiKeys");
const { PAYMENT_CATEGORIES, categoryOf, paymentCategoryOf } = await loadUtil("category");
const { csvText, paymentsCsv } = await loadUtil("csv");
const { matchesPaymentFilter, parsePaymentFilter } = await loadUtil("filter");
const { exportFilename } = await loadUtil("exportUtils");
const { paymentSublabel } = await loadUtil("searchUtils");
const { detectPayment, paymentHref, paymentLabel, paymentRef } = await loadUtil("paymentUtils");
const { resolveRecordRefs } = await load("refs");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY_MS = 86_400_000;
const AUTH_PASSED = JSON.stringify([{ id: "dmarc_passed" }]);
const HOOK_URL = "https://hooks.kite-validation.invalid/payments";
const owner = { id: "owner", role: "user", isPrimaryAdmin: false, timeZone: "UTC", email: "owner@example.com" };
const viewOf = (account) => ({ userId: account.id, role: account.role, isPrimaryAdmin: false, timeZone: "UTC" });

// --- categories --------------------------------------------------------------------------------------------------

test("a category is set only where exactly one is obvious, in English and Dutch", () => {
	const cases = [
		[{ vendor: "KLM", subject: "Your flight confirmation and receipt", sender: "klm.com" }, "travel"],
		[{ vendor: "Booking.com", subject: "Your hotel booking receipt", sender: "booking.com" }, "travel"],
		[{ vendor: "Hetzner", subject: "Invoice 2026-1043", sender: "hetzner.com" }, "software"],
		[{ vendor: "Cloudflare", subject: "Your domain names invoice", sender: "cloudflare.com" }, "software"],
		[{ vendor: "Thuisbezorgd", subject: "Bedankt voor je bestelling", sender: "thuisbezorgd.nl" }, "food"],
		[{ vendor: "Pizzeria Roma", subject: "Receipt for your order", sender: "stripe.com" }, "food"],
		[{ vendor: "Vattenfall", subject: "Je energienota van november", sender: "vattenfall.nl" }, "utilities"],
		[{ vendor: "Ziggo", subject: "Factuur internet", sender: "ziggo.nl" }, "utilities"],
		[{ vendor: "Apotheek Centrum", subject: "Uw bon", sender: "apotheek.example" }, "health"],
		[{ vendor: "Ticketmaster", subject: "Your tickets for the concert", sender: "ticketmaster.com" }, "entertainment"],
		[{ vendor: "Udemy", subject: "Your course receipt", sender: "udemy.com" }, "education"],
		[{ vendor: "Coolblue", subject: "Bestelbevestiging 20231234", sender: "coolblue.nl" }, "shopping"],
	];
	for (const [cues, category] of cases) assert.equal(categoryOf(cues), category, cues.vendor);
	// Nothing obvious, or two categories at once: no category rather than a guess.
	assert.equal(
		categoryOf({ vendor: "Kestrel Atlas", subject: "Your receipt [#1114-6093]", sender: "stripe.com" }),
		null,
	);
	assert.equal(categoryOf({ vendor: "Uber Eats", subject: "Your Uber Eats order", sender: "uber.com" }), "food");
	assert.equal(categoryOf({ vendor: "Uber", subject: "Your Tuesday trip", sender: "uber.com" }), "travel");
	assert.equal(categoryOf({ vendor: "Hotel Software GmbH", subject: "Invoice", sender: "example.com" }), null);
	assert.equal(categoryOf({ vendor: "Acme", subject: null, sender: null }), null);
});

test("a product word in a shop's subject never decides the category", () => {
	const cases = [
		[{ vendor: "Bol.com", subject: "Bevestiging van je bestelling: Training schoenen", sender: "bol.com" }, "shopping"],
		[{ vendor: "Decathlon", subject: "Your order: running shoes, training top", sender: "decathlon.nl" }, "shopping"],
		[{ vendor: "H&M", subject: "Your order training leggings", sender: "hm.com" }, "shopping"],
		[{ vendor: "Amazon", subject: 'Your Amazon.com order of "Cloud Atlas"', sender: "amazon.com" }, "shopping"],
		[{ vendor: "MediaMarkt", subject: "Bestelling: Nintendo Switch", sender: "mediamarkt.nl" }, "shopping"],
		[{ vendor: "Acme", subject: "Your order: online training course", sender: "acme.test" }, "shopping"],
		[{ vendor: "Acme", subject: "Your games and cloud storage receipt", sender: "acme.test" }, null],
		[{ vendor: "IKEA", subject: "Bestelling 1234", sender: "ikea.com" }, "shopping"],
		[{ vendor: "Jumbo", subject: "Je bestelling", sender: "jumbo.com" }, "food"],
		[{ vendor: "Albert Heijn", subject: "Bonnetje", sender: "ah.nl" }, "food"],
		[{ vendor: "Etos", subject: "Uw bestelling", sender: "etos.nl" }, "health"],
		[{ vendor: "Fysiotherapie Jansen", subject: "Factuur", sender: "jansen.example" }, "health"],
		[{ vendor: "Coursera", subject: "Receipt", sender: "coursera.org" }, "education"],
		[{ vendor: "Pathé", subject: "Je tickets", sender: "pathe.nl" }, "entertainment"],
		[{ vendor: "Steam", subject: "Thank you for your purchase", sender: "steampowered.com" }, "entertainment"],
		[{ vendor: "Taxi Centrale", subject: "Ride receipt", sender: "taxi.example" }, "travel"],
		[{ vendor: "Apple", subject: "Your receipt from Apple", sender: "apple.com" }, null],
		[{ vendor: "Patreon", subject: "Your Patreon receipt", sender: "patreon.com" }, null],
		[{ vendor: "Pizza Hosting Ltd", subject: "Invoice", sender: "example.com" }, null],
		[{ vendor: "The Cloud Bakery", subject: "Receipt", sender: "example.com" }, null],
		[{ vendor: "Acme", subject: "Your flight receipt", sender: "acme.test" }, "travel"],
		[{ vendor: "Amazon Web Services", subject: "Your AWS invoice", sender: "aws.amazon.com" }, "software"],
		[{ vendor: "Amazon", subject: "Your invoice", sender: "aws.amazon.com" }, "software"],
		[{ vendor: "Google Cloud", subject: "Your invoice", sender: "google.com" }, "software"],
		[{ vendor: "Microsoft Azure", subject: "Your invoice", sender: "microsoft.com" }, "software"],
		[{ vendor: "Amazon", subject: "Your order of a book", sender: "amazon.nl" }, "shopping"],
		[{ vendor: "Amazon Prime Video", subject: "Your receipt", sender: "primevideo.com" }, "entertainment"],
		[{ vendor: "Bolt Food", subject: "Your order", sender: "bolt.eu" }, "food"],
		[{ vendor: "Bolt", subject: "Your ride receipt", sender: "bolt.eu" }, "travel"],
		[{ vendor: "Steam", subject: "Thank you for your purchase", sender: "steampowered.com" }, "entertainment"],
		[{ vendor: "Steam Cleaning BV", subject: "Factuur", sender: "stoomreiniging.example" }, null],
		[{ vendor: "Disney Dental Clinic", subject: "Invoice", sender: "disneydental.example" }, null],
		[{ vendor: "Jumbo Visma Fanshop", subject: "Bestelling", sender: "fanshop.example" }, null],
		[{ vendor: "Studio Energie Yoga", subject: "Factuur", sender: "yoga.example" }, null],
		[{ vendor: "Disney", subject: "Your receipt", sender: "disneyplus.com" }, "entertainment"],
	];
	for (const [cues, category] of cases) assert.equal(categoryOf(cues), category, `${cues.vendor}: ${cues.subject}`);
});

test("only a category of the fixed set is a category", () => {
	assert.deepEqual(PAYMENT_CATEGORIES, [
		"software",
		"shopping",
		"food",
		"travel",
		"utilities",
		"health",
		"entertainment",
		"education",
		"other",
	]);
	for (const value of PAYMENT_CATEGORIES) assert.equal(paymentCategoryOf(value), value);
	for (const value of ["", "Travel", "gifts", null, undefined, 3, {}, "other "])
		assert.equal(paymentCategoryOf(value), null, String(value));
	// The schema's enum is the same list, so a category the code accepts is one the column's type allows.
	const schema = readFileSync(join(root, "src/db/schema/finance.ts"), "utf8");
	const listed = /category: text\("category", \{\s*enum: \[([^\]]+)\]/.exec(schema)?.[1];
	assert.deepEqual(
		listed?.split(",").map((item) => item.trim().replaceAll('"', "")),
		PAYMENT_CATEGORIES,
	);
});

// --- CSV and filters ---------------------------------------------------------------------------------------------

test("CSV cells never start a formula and quote what needs it", () => {
	assert.equal(csvText("Acme"), "Acme");
	assert.equal(csvText("Acme, Inc."), '"Acme, Inc."');
	assert.equal(csvText('The "Best" Shop'), '"The ""Best"" Shop"');
	assert.equal(csvText("Line\nbreak"), '"Line\nbreak"');
	for (const hostile of [
		'=HYPERLINK("http://evil.example","x")',
		"+1+1",
		"-2+3",
		"@SUM(A1)",
		"\tcmd",
		"\rcmd",
		"\uff1d1+1",
		"\uff0b1",
		"\uff0d1",
		"\uff20SUM(A1)",
		"\u00a0=1+1",
		"  =1",
		"\u200b=1",
		"|cmd",
		"\u200e=1",
		"\u061c=1",
		"\u2212=1",
		"\ufe62=1",
	])
		assert.ok(csvText(hostile).replace(/^"/, "").startsWith("'"), JSON.stringify(hostile));
	assert.equal(csvText("a=b"), "a=b", "only the first character matters");
});

test("the CSV holds the rows as plain values, refunds negative, with a BOM and CRLF", () => {
	const csv = paymentsCsv([
		{
			documentOn: "2026-11-02",
			vendor: "Kestrel Atlas",
			docType: "payment",
			status: "paid",
			amount: { minor: 50_000, currency: "USD" },
			category: null,
			source: "payment",
		},
		{
			documentOn: "2026-11-01",
			vendor: "=cmd|' /C calc'!A0",
			docType: "refund",
			status: "refunded",
			amount: { minor: 1_250, currency: "EUR" },
			category: "shopping",
			source: "payment",
		},
		{
			documentOn: "2026-10-30",
			vendor: "Netflix",
			docType: "invoice",
			status: "paid",
			amount: { minor: 1_799, currency: "JPY" },
			category: null,
			source: "subscription",
		},
		{
			documentOn: "2026-10-29",
			vendor: "No amount",
			docType: "failed_payment",
			status: "failed",
			amount: null,
			category: null,
			source: "subscription",
		},
	]);
	assert.ok(csv.startsWith("﻿Date,Vendor,Type,Status,Amount,Currency,Category,Source\r\n"));
	assert.deepEqual(csv.slice(1).split("\r\n"), [
		"Date,Vendor,Type,Status,Amount,Currency,Category,Source",
		"2026-11-02,Kestrel Atlas,payment,paid,500.00,USD,,mail",
		"2026-11-01,'=cmd|' /C calc'!A0,refund,refunded,-12.50,EUR,shopping,mail",
		"2026-10-30,Netflix,invoice,paid,1799,JPY,,subscription",
		"2026-10-29,No amount,failed_payment,failed,,,,subscription",
		"",
	]);
});

test("the filters match as the tab does and a query string is checked before use", () => {
	const row = { vendor: "Acme", documentOn: "2026-11-02", status: "paid", category: "travel" };
	assert.equal(matchesPaymentFilter(row, {}), true);
	assert.equal(
		matchesPaymentFilter(row, { vendor: "Acme", month: "2026-11", status: "paid", category: "travel" }),
		true,
	);
	assert.equal(matchesPaymentFilter(row, { month: "2026-10" }), false);
	assert.equal(matchesPaymentFilter(row, { category: "none" }), false);
	assert.equal(matchesPaymentFilter({ ...row, category: null }, { category: "none" }), true);
	assert.equal(matchesPaymentFilter({ ...row, category: null }, { category: "travel" }), false);
	const parse = (query) => parsePaymentFilter(new URLSearchParams(query));
	assert.deepEqual(parse("month=2026-11&status=paid&category=none&vendor=Acme"), {
		filter: { vendor: "Acme", month: "2026-11", status: "paid", category: "none" },
	});
	assert.deepEqual(parse(""), { filter: { vendor: "", month: "", status: "", category: "" } });
	for (const bad of ["month=2026-13", "month=nov", "status=lost", "category=gifts", `vendor=${"x".repeat(201)}`])
		assert.ok("error" in parse(bad), bad);
	assert.equal(
		exportFilename({ month: "2026-11" }, new Date("2026-12-05T10:00:00Z")),
		"money-watch-payments-2026-11.csv",
	);
	assert.equal(exportFilename({}, new Date("2026-12-05T10:00:00Z")), "money-watch-payments-2026-12-05.csv");
});

// --- the module with a database ----------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'UTC', 1),
			('member', 'member@example.com', 'hash', 'Member', 'UTC', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'me', 'personal', 1),
			('mailbox-noai', 'owner', 'domain-1', 'private', 'personal', 2);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES
			('mailbox-a', 1, 'suggest', 'owner', '{}', 1),
			('mailbox-noai', 1, 'suggest', 'owner', '{}', 1);
		UPDATE mailbox_agent_settings SET ai_disabled = 1 WHERE mailbox_id = 'mailbox-noai';
		UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1;
	`);
	const addHook = db.db.prepare(
		"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES (?, ?, ?, 'whsec_test', ?, 1, 3, 1)",
	);
	addHook.run("wh-owner", "owner", HOOK_URL, JSON.stringify(["finance.payment.recorded"]));
	addHook.run("wh-member", "member", HOOK_URL, JSON.stringify(["finance.payment.recorded"]));
	const queued = [];
	const sent = [];
	const env = {
		DB: db,
		OUTBOUND_QUEUE: { send: async (message) => void queued.push(message) },
		AGENT_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	globalThis.fetch = async (url) => {
		sent.push(String(url));
		return new Response("ok", { status: 200 });
	};
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		globalThis.fetch = realFetch;
		clearModuleStateCache();
	});
	const deliveries = () =>
		db.db
			.prepare("SELECT webhook_id, event_type, payload FROM webhook_deliveries ORDER BY created_at, rowid")
			.all()
			.map((row) => ({ webhookId: row.webhook_id, event: row.event_type, body: JSON.parse(row.payload) }));
	return { db, deliveries, queued, sent };
}

let counter = 0;
function insertMessage(db, mail, { mailboxId = "mailbox-a", daysAgo = 1 } = {}) {
	const id = `message-${++counter}`;
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_signals, created_at) VALUES (?, 'owner', ?, 'inbound', ?, 'me@example.com', ?, ?, 'received', ?, ?)",
		)
		.run(
			id,
			mailboxId,
			mail.from,
			mail.subject,
			mail.body,
			AUTH_PASSED,
			Math.floor((Date.now() - daysAgo * DAY_MS) / 1000),
		);
	return id;
}

function stepInput(messageId, mail, { mailboxId = "mailbox-a" } = {}) {
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
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null, messageId: null },
		attachments: [],
		model: null,
	};
}

async function record(messageId, mail, options) {
	const ctx = buildCallContext({
		trigger: "auto_read",
		viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
		timeZone: "UTC",
		mailboxIds: [options?.mailboxId ?? "mailbox-a"],
		grants: ["finance.read", "finance.write"],
	});
	const result = await invokeCapability("finance", "recordPayment", stepInput(messageId, mail, options), ctx);
	assert.equal(result.ok, true, JSON.stringify(result));
}

const readCtx = (userId, trigger = "mcp") => ({
	viewer: { userId, role: "user", isPrimaryAdmin: false },
	requestId: "r",
	locale: "en",
	timeZone: "UTC",
	grants: ["finance.read"],
	trigger,
});

const FLIGHT = {
	from: "KLM <billing@klm.com>",
	subject: "Your flight receipt [#KL-7781]",
	body: "Flight receipt\nReceipt #KL-7781\nAmount paid\n€212.40\nDate paid\nNov 2, 2026",
};
const HOSTING = {
	from: "Hetzner <invoices@hetzner.example>",
	subject: "Invoice INV-2041 from Hetzner hosting",
	body: "Amount due: €120.00\nInvoice date: 28 Oct 2026",
};
const STRIPE = {
	from: "Stripe <receipts+acct_1AbCdEfGhIjKlMn@stripe.com>",
	subject: "Your Kestrel Atlas receipt [#1114-6093]",
	body: "Kestrel Atlas\nReceipt #1114-6093\n\nAmount paid\n$500.00\n\nDate paid\nNov 2, 2026",
};

const payments = (db) =>
	db.db
		.prepare("SELECT id, vendor, doc_type, category, currency FROM finance_payments ORDER BY created_at, rowid")
		.all();

test("a recorded payment gets a category only where one is obvious, and its owner's webhook hears of it", async (t) => {
	const { db, deliveries, queued, sent: fetched } = await setup(t);
	const flightMessage = insertMessage(db, FLIGHT);
	await record(flightMessage, FLIGHT);
	await record(insertMessage(db, STRIPE), STRIPE);
	await record(insertMessage(db, HOSTING), HOSTING);
	assert.deepEqual(
		payments(db).map((row) => [row.vendor, row.category]),
		[
			["KLM", "travel"],
			["Kestrel Atlas", null],
			["Hetzner", "software"],
		],
	);
	const sent = deliveries();
	assert.equal(sent.length, 3, "one delivery per payment, to the owner's hook only");
	assert.ok(
		sent.every((delivery) => delivery.webhookId === "wh-owner" && delivery.event === "finance.payment.recorded"),
	);
	const [flight] = payments(db);
	const body = sent[0].body;
	assert.deepEqual(body.data.payment, {
		ref: { kind: "finance:payment", id: flight.id },
		vendor: "KLM",
		docType: "payment",
		status: "paid",
		amount: { minor: 21_240, currency: "EUR" },
		documentOn: "2026-11-02",
		category: "travel",
	});
	assert.equal(body.data.source, undefined, "no scan or auto flag in the payload");
	assert.deepEqual(body.data.message, { kind: "mail:message", id: flightMessage });
	// Recording the same message again writes and announces nothing.
	await record(flightMessage, FLIGHT);
	assert.equal(deliveries().length, 3);
	// The first attempt is queued, never made inside the recording step, so a slow endpoint cannot hold it up.
	assert.deepEqual(fetched, [], "no request left during recording");
	assert.equal(queued.filter((message) => message.kind === "webhook.retry").length, 3);
	assert.deepEqual(
		new Set(queued.map((message) => message.deliveryId)),
		new Set(
			db.db
				.prepare("SELECT id FROM webhook_deliveries")
				.all()
				.map((row) => row.id),
		),
	);
});

test("the historical scan records payments but announces none", async (t) => {
	const { db, deliveries, queued } = await setup(t);
	const message = insertMessage(db, FLIGHT);
	const ctx = buildCallContext({
		trigger: "queue",
		viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
		timeZone: "UTC",
		mailboxIds: ["mailbox-a"],
		grants: ["finance.read", "finance.write"],
	});
	assert.equal(await recordPaymentFromInput(ctx, stepInput(message, FLIGHT), "scan"), "recorded");
	assert.equal(payments(db).length, 1);
	assert.deepEqual(deliveries(), []);
	assert.deepEqual(queued, []);
});

test("the category is changed from the Payments tab with Undo, and only to a category of the set", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, STRIPE), STRIPE);
	const [{ id }] = payments(db);
	const set = await patchPayment(owner, id, { fields: { category: "software" } });
	assert.equal(set.status, 200, JSON.stringify(set.body));
	assert.equal(set.body.payment.category, "software");
	assert.equal(payments(db)[0].category, "software");
	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, set.body.actionId);
	assert.equal(payments(db)[0].category, null, "undo puts back no category");

	const again = await patchPayment(owner, id, { fields: { category: "other", vendor: "Kestrel" } });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	const cleared = await patchPayment(owner, id, { fields: { category: null } });
	assert.equal(cleared.status, 200);
	assert.equal(payments(db)[0].category, null);
	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, cleared.body.actionId);
	assert.equal(payments(db)[0].category, "other", "undo of a clear puts the category back");

	for (const category of ["gifts", "", "Travel", 5, ["travel"]])
		assert.equal((await patchPayment(owner, id, { fields: { category } })).status, 400, JSON.stringify(category));
	// A change that leaves the category alone neither writes nor restores it.
	const vendorOnly = await patchPayment(owner, id, { fields: { vendor: "Kestrel Group" } });
	db.db.prepare("UPDATE finance_payments SET category = 'health'").run();
	await undoAgentAction(globalThis.__kiteNodeEnv, { id: "owner", role: "user" }, vendorOnly.body.actionId);
	assert.equal(payments(db)[0].category, "health");
});

test("list_payments, the search section and the refs answer for the owner only, and honour the filters", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	await record(insertMessage(db, HOSTING), HOSTING);
	await record(insertMessage(db, STRIPE), STRIPE);
	const list = (userId, input = {}, trigger) =>
		invokeCapability("finance", "list_payments", input, readCtx(userId, trigger));
	const all = await list("owner");
	assert.equal(all.ok, true, JSON.stringify(all));
	assert.deepEqual(
		// KLM and Kestrel Atlas are dated the same day, so their order is not fixed; Hetzner is older.
		all.output.payments.map((row) => [row.vendor, row.category, row.amount.minor]).sort(([a], [b]) => (a < b ? -1 : 1)),
		[
			["Hetzner", "software", 12_000],
			["KLM", "travel", 21_240],
			["Kestrel Atlas", null, 50_000],
		],
	);
	assert.equal(all.output.payments.at(-1).vendor, "Hetzner", "the older payment comes last");
	assert.deepEqual(all.output.months, [
		{ month: "2026-11", currency: "EUR", paidMinor: 21_240, refundedMinor: 0, openMinor: 0 },
		{ month: "2026-11", currency: "USD", paidMinor: 50_000, refundedMinor: 0, openMinor: 0 },
		{ month: "2026-10", currency: "EUR", paidMinor: 0, refundedMinor: 0, openMinor: 12_000 },
	]);
	assert.deepEqual(
		(await list("owner", { category: "none" })).output.payments.map((row) => row.vendor),
		["Kestrel Atlas"],
	);
	assert.deepEqual(
		(await list("owner", { category: "travel" })).output.payments.map((row) => row.vendor),
		["KLM"],
	);
	assert.deepEqual(
		(await list("owner", { status: "open" })).output.payments.map((row) => row.vendor),
		["Hetzner"],
	);
	assert.deepEqual((await list("owner", { vendor: "KLM", month: "2026-11" })).output.payments.length, 1);
	assert.equal((await list("owner", { limit: 1 })).output.payments.length, 1);
	assert.equal(
		(await list("owner", { limit: 1 })).output.months.length,
		3,
		"totals cover every match, not just the page",
	);
	assert.deepEqual((await list("member")).output, { payments: [], months: [] });
	for (const input of [{ limit: 51 }, { limit: 0 }, { month: "2026-13" }, { category: "gifts" }, { status: "lost" }])
		assert.equal((await list("owner", input)).error?.code, "invalid_input", JSON.stringify(input));
	const noGrant = await invokeCapability("finance", "list_payments", {}, { ...readCtx("owner"), grants: [] });
	assert.equal(noGrant.ok, false, "the key needs mcp:finance-read");

	// Search: vendor and document number, the owner's rows, `%` and `_` taken literally.
	const search = (userId, query) =>
		invokeCapability("finance", "searchPayments", { query, limit: 20 }, readCtx(userId));
	const found = (await search("owner", "klm")).output.items;
	assert.deepEqual(
		found.map((item) => item.label),
		["KLM · €212.40"],
	);
	assert.equal(found[0].href, `/finance?tab=payments&payment=${found[0].ref.id}`);
	assert.deepEqual(found[0].ref.kind, "finance:payment");
	assert.match(found[0].sublabel, /^Payment · .* · travel$/);
	assert.equal((await search("owner", "kl-7781")).output.items.length, 1, "by document number");
	assert.deepEqual((await search("owner", "k%m")).output.items, []);
	assert.deepEqual((await search("member", "klm")).output.items, []);

	// Refs: the owner's live rows resolve; a removed row and another user's row are unavailable.
	const [first] = payments(db);
	const ref = { kind: "finance:payment", id: first.id };
	const viewer = { userId: "owner", role: "user", isPrimaryAdmin: false };
	const resolve = (who) => resolveRecordRefs(globalThis.__kiteNodeEnv, who, [ref], { timeZone: "UTC", trigger: "api" });
	const [live] = await resolve(viewer);
	assert.equal(live.unavailable, undefined);
	assert.equal(live.label, "KLM · €212.40");
	assert.equal(live.href, found[0].href);
	const [other] = await resolve({ ...viewer, userId: "member" });
	assert.equal(other.unavailable, true);
	db.db.prepare("UPDATE finance_payments SET removed_at = 1 WHERE id = ?").run(first.id);
	assert.equal((await resolve(viewer))[0].unavailable, true);
	assert.deepEqual((await search("owner", "klm")).output.items, []);
	assert.equal((await list("owner")).output.payments.length, 2);
});

test("in the chat a payment from a mailbox with AI off is left out of list_payments", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	const hidden = insertMessage(db, HOSTING, { mailboxId: "mailbox-noai" });
	db.db
		.prepare(
			"INSERT INTO finance_payments (id, user_id, mailbox_id, message_id, vendor, vendor_key, doc_type, status, amount_minor, currency, document_at, source, created_at, updated_at) VALUES ('fpay_private', 'owner', 'mailbox-noai', ?, 'Private Clinic', 'clinic.example', 'invoice', 'open', 5000, 'EUR', 1793000000, 'auto', 1, 1)",
		)
		.run(hidden);
	const list = (trigger) => invokeCapability("finance", "list_payments", {}, readCtx("owner", trigger));
	assert.deepEqual(
		(await list("chat")).output.payments.map((row) => row.vendor),
		["KLM"],
	);
	assert.equal((await list("mcp")).output.payments.length, 2, "the rule is the chat's; a key the owner made sees both");
});

test("the export holds the tab's rows, honours its filters and counts subscription documents too", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	await record(insertMessage(db, HOSTING), HOSTING);
	db.db.exec(`
		INSERT INTO finance_subscriptions (id, user_id, vendor, vendor_key, status, reminder_days, created_at, updated_at) VALUES ('fsub_1', 'owner', 'Acmeflix', 'acmeflix.example', 'active', 3, 1, 1);
		INSERT INTO finance_charges (id, subscription_id, user_id, doc_type, amount_minor, currency, document_at, created_at) VALUES ('fchg_1', 'fsub_1', 'owner', 'payment', 1799, 'USD', 1793500000, 1);
	`);
	const everything = await paymentsForExport("owner", {});
	assert.equal(everything.truncated, false);
	assert.deepEqual(
		everything.rows.map((row) => [row.vendor, row.source, row.category]),
		[
			["KLM", "payment", "travel"],
			["Acmeflix", "subscription", null],
			["Hetzner", "payment", "software"],
		],
	);
	assert.deepEqual(
		(await paymentsForExport("owner", { category: "travel" })).rows.map((row) => row.vendor),
		["KLM"],
	);
	assert.deepEqual(
		(await paymentsForExport("owner", { category: "none" })).rows.map((row) => row.vendor),
		["Acmeflix"],
	);
	assert.deepEqual(
		(await paymentsForExport("owner", { status: "open" })).rows.map((row) => row.vendor),
		["Hetzner"],
	);
	assert.deepEqual((await paymentsForExport("member", {})).rows, []);
	const view = await listPaymentsView(viewOf(owner));
	assert.equal(view.payments.length, everything.rows.length, "the tab and the file list the same rows");
	assert.deepEqual(
		view.payments.map((row) => row.category),
		everything.rows.map((row) => row.category),
	);
});

test("before migration 0109 payments still record, list and change, and only the category waits", async (t) => {
	const { db } = await setup(t);
	db.db.exec("ALTER TABLE finance_payments DROP COLUMN category;");
	const messageId = insertMessage(db, FLIGHT);
	await record(messageId, FLIGHT);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM finance_payments").get().n,
		1,
		"the row is recorded without it",
	);
	const row = db.db.prepare("SELECT id FROM finance_payments").get();
	const view = await listPaymentsView(viewOf(owner));
	assert.deepEqual(
		view.payments.map((item) => [item.vendor, item.category]),
		[["KLM", null]],
	);
	assert.equal((await paymentsForExport("owner", {})).rows.length, 1);
	assert.equal((await invokeCapability("finance", "list_payments", {}, readCtx("owner"))).output.payments.length, 1);
	assert.equal(
		(await invokeCapability("finance", "searchPayments", { query: "klm", limit: 5 }, readCtx("owner"))).output.items
			.length,
		1,
	);
	const renamed = await patchPayment(owner, row.id, { fields: { vendor: "KLM Royal Dutch" } });
	assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
	const blocked = await patchPayment(owner, row.id, { fields: { category: "travel" } });
	assert.equal(blocked.status, 409);
	assert.match(blocked.body.error, /pending database update/i);
	// Recording the same message again is still a no-op.
	await record(messageId, FLIGHT);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM finance_payments").get().n, 1);
});

test("with Money Watch off the tool, the search and the refs are absent", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	db.db.exec(
		"INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES ('finance', 'finance', 0, 1) ON CONFLICT (module_id) DO UPDATE SET enabled = 0",
	);
	clearModuleStateCache();
	for (const [name, input] of [
		["list_payments", {}],
		["searchPayments", { query: "klm", limit: 5 }],
	]) {
		const result = await invokeCapability("finance", name, input, readCtx("owner"));
		assert.equal(result.ok, false, name);
		assert.equal(result.error.code, "module_disabled", name);
	}
});

// --- coverage of the small helpers --------------------------------------------------------------------------------

test("a category needs a word in the vendor, subject or sender, and a missing subject or sender is no cue", () => {
	assert.equal(categoryOf({ vendor: "Acme", subject: null, sender: null }), null);
	assert.equal(categoryOf({ vendor: "Acme", subject: null, sender: "acme.test" }), null);
	assert.equal(categoryOf({ vendor: "Acme", subject: "Your order has shipped", sender: null }), "shopping");
	assert.equal(categoryOf({ vendor: "Acme", subject: null, sender: "hetzner.com" }), "software");
	assert.equal(
		categoryOf({ vendor: "", subject: "Flight and cinema", sender: null }),
		null,
		"two categories give none",
	);
	assert.equal(paymentCategoryOf(42), null);
	assert.equal(paymentCategoryOf(null), null);
});

test("a payment's ref, link and label name the row, with a minus for money that came back", () => {
	assert.deepEqual(paymentRef("fpay_1"), { kind: "finance:payment", id: "fpay_1" });
	assert.equal(paymentHref("fpay 1"), "/finance?tab=payments&payment=fpay%201");
	assert.match(
		paymentLabel({ vendor: "Acme", amountMinor: 1250, currency: "EUR", docType: "payment" }, "en"),
		/^Acme · €12\.50$/,
	);
	assert.match(
		paymentLabel({ vendor: "Acme", amountMinor: 1250, currency: "EUR", docType: "refund" }, "en"),
		/^Acme · −€12\.50$/,
	);
	assert.match(paymentLabel({ vendor: "Acme", amountMinor: 1250, currency: "EUR", docType: "credit" }, "en"), /−/);
	assert.equal(typeof detectPayment, "function");
});

test("a search row's second line names the type, the day and the category when there is one", () => {
	const at = new Date("2026-11-03T10:00:00Z");
	assert.equal(
		paymentSublabel({ docType: "payment", documentAt: at, category: "shopping" }),
		"Payment · 3 Nov · shopping",
	);
	assert.equal(paymentSublabel({ docType: "credit", documentAt: at, category: null }), "Credit note · 3 Nov");
	assert.equal(paymentSublabel({ docType: "invoice", documentAt: at, category: null }), "Invoice · 3 Nov");
});

// --- a stored category outside the set, and who may list what ----------------------------------------------------

test("a stored category outside the set reads as none on every surface", async (t) => {
	const { db } = await setup(t);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	await record(insertMessage(db, HOSTING), HOSTING);
	db.db.prepare("UPDATE finance_payments SET category = 'gifts' WHERE vendor = 'KLM'").run();
	db.db.prepare("UPDATE finance_payments SET category = '=cmd|calc' WHERE vendor = 'Hetzner'").run();

	const view = await listPaymentsView(viewOf(owner));
	assert.deepEqual(
		view.payments.map((row) => row.category),
		[null, null],
	);
	const exported = await paymentsForExport("owner", {});
	assert.deepEqual(
		exported.rows.map((row) => row.category),
		[null, null],
	);
	assert.ok(!/gifts|calc/.test(paymentsCsv(exported.rows)), "nothing foreign reaches the file");
	const tool = await invokeCapability("finance", "list_payments", {}, readCtx("owner"));
	assert.equal(tool.ok, true, JSON.stringify(tool));
	assert.deepEqual(
		tool.output.payments.map((row) => row.category),
		[null, null],
	);
	assert.equal(
		(await invokeCapability("finance", "list_payments", { category: "none" }, readCtx("owner"))).output.payments.length,
		2,
		"the filter agrees with what is shown",
	);
	const found = await invokeCapability("finance", "searchPayments", { query: "klm", limit: 5 }, readCtx("owner"));
	assert.doesNotMatch(found.output.items[0].sublabel, /gifts/);
	// A hostile stored category in the CSV itself is still neutralised (defence in depth).
	assert.ok(
		paymentsCsv([
			{
				documentOn: "2026-11-02",
				vendor: "Acme",
				docType: "payment",
				status: "paid",
				amount: { minor: 100, currency: "=EUR" },
				category: "=cmd",
				source: "payment",
			},
		]).includes("'=EUR"),
	);
	// The tab's own row can be corrected as before.
	const [row] = db.db.prepare("SELECT id FROM finance_payments WHERE vendor = 'KLM'").all();
	const fixed = await patchPayment(owner, row.id, { fields: { category: "travel" } });
	assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
});

test("list_payments honours a key's mailbox limit and a withdrawn mailbox", async (t) => {
	const { db } = await setup(t);
	db.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'second', 'personal', 3);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES ('mailbox-b', 1, 'suggest', 'owner', '{}', 1);
	`);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	await record(insertMessage(db, HOSTING, { mailboxId: "mailbox-b" }), HOSTING, { mailboxId: "mailbox-b" });
	const list = (mailboxIds, trigger = "mcp", mailboxLimited = false) =>
		invokeCapability(
			"finance",
			"list_payments",
			{},
			{
				...readCtx("owner", trigger),
				...(mailboxIds ? { mailboxIds } : {}),
				...(mailboxLimited ? { mailboxLimited: true } : {}),
			},
		);
	const vendors = async (...args) => {
		const answer = await list(...args);
		assert.equal(answer.ok, true, JSON.stringify(answer));
		return answer.output.payments.map((row) => row.vendor).sort();
	};
	assert.deepEqual(await vendors(["mailbox-a"]), ["KLM"], "a key limited to one mailbox sees only its payments");
	assert.deepEqual(await vendors(["mailbox-b"]), ["Hetzner"]);
	assert.deepEqual(await vendors([]), ["Hetzner", "KLM"], "a key that names no mailbox is not limited");
	assert.deepEqual(await vendors(undefined, "chat"), ["Hetzner", "KLM"]);
	// A key that named mailboxes, all of which have since become unreadable, sees nothing (not everything).
	assert.deepEqual(await vendors([], "mcp", true), [], "named but none readable fails closed");
	assert.deepEqual(await vendors(["mailbox-a"], "mcp", true), ["KLM"]);
	// A mailbox the viewer can no longer read lists nothing, even for an unlimited call.
	db.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mailbox-b'").run();
	assert.deepEqual(await vendors([]), ["KLM"]);
});

test("list_payments through a real MCP key: limited to its readable mailboxes, nothing when they are gone, all for a finance-only key", async (t) => {
	const { db } = await setup(t);
	db.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'second', 'personal', 3);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES ('mailbox-b', 1, 'suggest', 'owner', '{}', 1);
	`);
	await record(insertMessage(db, FLIGHT), FLIGHT);
	await record(insertMessage(db, HOSTING, { mailboxId: "mailbox-b" }), HOSTING, { mailboxId: "mailbox-b" });
	const makeKey = (scopes, mailboxIds) => {
		const key = generateApiKey();
		const id = `key-${++counter}`;
		db.db
			.prepare(
				"INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, 'mcp', 'owner', 'e2e', ?, ?, ?, 1)",
			)
			.run(id, key.prefix, key.hash, scopesToJson(scopes));
		for (const mailboxId of mailboxIds)
			db.db.prepare("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (?, ?)").run(id, mailboxId);
		return key.fullKey;
	};
	// What the MCP server does with the authenticated principal, then the tool call itself.
	const listed = async (fullKey) => {
		const principal = await authenticateMcpRequest(
			globalThis.__kiteNodeEnv,
			new Request("https://kite.test/mcp", { headers: { Authorization: `Bearer ${fullKey}` } }),
		);
		assert.ok(principal, "the key authenticates");
		const ctx = buildCallContext({
			trigger: "mcp",
			viewer: { userId: principal.user.id, role: principal.user.role, isPrimaryAdmin: false },
			timeZone: "UTC",
			mailboxIds: principal.mailboxIds,
			mailboxLimited: principal.mailboxLimited,
			grants: ["finance.read"],
		});
		const answer = await invokeCapability("finance", "list_payments", {}, ctx);
		assert.equal(answer.ok, true, JSON.stringify(answer));
		return answer.output.payments.map((row) => row.vendor).sort();
	};
	const scopes = ["mcp:read", "mcp:finance-read"];

	assert.deepEqual(await listed(makeKey(scopes, ["mailbox-a"])), ["KLM"], "named and readable: only its mailbox");
	assert.deepEqual(
		await listed(makeKey(["mcp:finance-read"], [])),
		["Hetzner", "KLM"],
		"a finance-only key names none",
	);

	const unshared = makeKey(scopes, ["mailbox-b"]);
	assert.deepEqual(await listed(unshared), ["Hetzner"]);
	db.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mailbox-b'").run();
	assert.deepEqual(await listed(unshared), [], "named, none readable any more: nothing");

	const deleted = makeKey(scopes, ["mailbox-b"]);
	// Removing the mailbox cascades away the key's row, which is what a deleted mailbox does to a key.
	db.db.pragma?.("foreign_keys = ON");
	db.db.prepare("DELETE FROM messages WHERE mailbox_id = 'mailbox-b'").run();
	db.db.prepare("DELETE FROM mailboxes WHERE id = 'mailbox-b'").run();
	assert.equal(
		db.db.prepare("SELECT 1 FROM mcp_key_mailboxes WHERE mailbox_id = 'mailbox-b'").all().length,
		0,
		"the key names no mailbox any more",
	);
	assert.deepEqual(await listed(deleted), [], "named mailboxes deleted (rows cascaded away): nothing, not everything");
});
