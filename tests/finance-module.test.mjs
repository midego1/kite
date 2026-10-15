import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { loadFinance } from "./support/finance-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-module-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		api: join(root, "src/lib/agent/auto-read/suggestion-api.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		activity: join(root, "src/lib/agent/auto-read/activity.ts"),
		labels: join(root, "src/components/agent/agent-activity-utils.ts"),
		invoke: join(root, "src/lib/modules/invoke.ts"),
		host: join(root, "src/lib/modules/host.ts"),
		refs: join(root, "src/lib/modules/record-refs.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		views: join(root, "src/lib/finance/views.ts"),
		subscriptions: join(root, "src/lib/finance/subscriptions.ts"),
		removal: join(root, "src/lib/finance/removal-snapshot.ts"),
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
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { acceptSuggestion } = await load("api");
const { executeAction, undoAgentAction } = await load("execute");
const { listAgentActivity } = await load("activity");
const { actionLabel } = await load("labels");
const { invokeCapability } = await load("invoke");
const { moduleHost } = await load("host");
const { resolveRecordRefs } = await load("refs");
const { clearModuleStateCache } = await load("state");
const { listSubscriptionsView, subscriptionDetailView } = await load("views");
const { ownerRow, documentRow } = await load("subscriptions");
const { subscriptionRemovalSnapshot, documentRemovalSnapshot } = await load("removal");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY_MS = 86_400_000;
const day = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const SENDER = "Streamflix Billing <billing@streamflix.example>";
const HOOK_URL = "https://hooks.kite-validation.invalid/finance";

const user = (id) => ({ id, role: "user", isPrimaryAdmin: false, timeZone: "UTC", email: `${id}@example.com` });
const owner = user("owner");
const member = user("member");
const viewOf = (account) => ({ userId: account.id, role: account.role, isPrimaryAdmin: false, timeZone: "UTC" });

function card(overrides = {}) {
	return {
		event: "new",
		subscriptionId: null,
		vendor: "Streamflix",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		previousAmountMinor: null,
		cycle: "monthly",
		nextRenewalOn: day(20),
		renewalEstimated: false,
		trialEndsOn: null,
		cancelLink: { url: "https://streamflix.example/cancel", oneClick: false },
		document: { docType: "invoice", documentOn: day(-40), periodStartOn: null, periodEndOn: null, attachmentId: null },
		unverified: false,
		signals: ["subject_keyword", "cycle", "renewal_date"],
		modelFields: [],
		modelDisagrees: [],
		...overrides,
	};
}

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
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'member', 'full_access', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES
			('contact-1', 'owner', 'billing@streamflix.example', 'Streamflix Billing', 'inbound', 1);
	`);
	const addHook = db.db.prepare(
		"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES (?, ?, ?, 'whsec_test', ?, 1, 3, 1)",
	);
	addHook.run("wh-owner", "owner", HOOK_URL, JSON.stringify(["finance.subscription.detected"]));
	addHook.run("wh-member", "member", HOOK_URL, JSON.stringify(["finance.subscription.detected"]));
	const env = { DB: db, OUTBOUND_QUEUE: { send: async () => undefined } };
	globalThis.__kiteNodeEnv = env;
	globalThis.fetch = async () => new Response("ok", { status: 200 });
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		globalThis.fetch = realFetch;
		clearModuleStateCache();
	});
	let order = 10;
	const addMessage = (id, { attachments = [] } = {}) => {
		order += 1;
		db.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', ?, 'support@example.com', 'Your invoice', 'Invoice', 'received', ?)",
			)
			.run(id, SENDER, order);
		for (const attachment of attachments)
			db.db
				.prepare(
					"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, ?, 'application/pdf', 1200, ?, 1)",
				)
				.run(attachment, id, `${attachment}.pdf`, `att/${attachment}`);
	};
	const addCard = (id, messageId, payload, status = "open") => {
		addMessage(messageId, { attachments: payload.document?.attachmentId ? [payload.document.attachmentId] : [] });
		db.db
			.prepare(
				"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES (?, 'mailbox-a', ?, 'owner', 'subscription', ?, 'Track it?', ?, ?)",
			)
			.run(id, messageId, status, JSON.stringify(payload), order);
	};
	const rows = () => db.db.prepare("SELECT * FROM finance_subscriptions ORDER BY created_at").all();
	const documents = () => db.db.prepare("SELECT * FROM finance_charges ORDER BY document_at, rowid").all();
	const suggestion = (id) => db.db.prepare("SELECT * FROM agent_suggestions WHERE id = ?").get(id);
	const deliveries = () =>
		db.db
			.prepare("SELECT webhook_id, event_type, payload FROM webhook_deliveries ORDER BY created_at, rowid")
			.all()
			.map((row) => ({ webhookId: row.webhook_id, event: row.event_type, body: JSON.parse(row.payload) }));
	return { db, env, addMessage, addCard, rows, documents, suggestion, deliveries };
}

const accept = (env, id, option = "track", account = owner) => acceptSuggestion(env, account, id, option, null);

async function trackFirst(context) {
	context.addCard("sugg-1", "inv-1", card());
	return accept(context.env, "sugg-1");
}

async function labels(env) {
	const { actions } = await listAgentActivity(env, "mailbox-a", "owner");
	return actions.map((action) => ({ label: actionLabel(action), status: action.status, target: action.target }));
}

test("Track creates the row and its invoice document through one audited action; a double click repeats it", async (t) => {
	const context = await setup(t);
	const { env, rows, documents, suggestion, deliveries } = context;
	const first = await trackFirst(context);
	assert.equal(first.status, "accepted");
	assert.match(first.actionId, /^aact_/);
	const [row] = rows();
	assert.equal(row.id, "fsub_s_sugg-1", "the row's id derives from the card");
	assert.deepEqual(first.subscription, { kind: "finance:subscription", id: row.id });
	assert.equal(row.user_id, "owner");
	assert.equal(row.contact_id, "contact-1");
	assert.equal(row.source_message_id, "inv-1");
	assert.equal(row.cancel_url, "https://streamflix.example/cancel");
	assert.equal(suggestion("sugg-1").status, "accepted");
	const [document] = documents();
	assert.equal(document.doc_type, "invoice");
	assert.equal(document.message_id, "inv-1");
	assert.equal(document.amount_minor, 1799);

	const again = await accept(env, "sugg-1");
	assert.equal(again.actionId, first.actionId, "a double click hands back the first action");
	assert.equal(rows().length, 1);
	assert.equal(documents().length, 1);

	const listed = await listSubscriptionsView(viewOf(owner), null);
	assert.equal(listed.subscriptions.length, 1);
	const view = listed.subscriptions[0];
	assert.deepEqual(view.amount, { minor: 1799, currency: "USD" });
	assert.equal(view.cycle, "monthly");
	assert.equal(view.status, "active");
	assert.equal(view.reminderDays, 3);
	assert.equal(view.calendarReminder, true);
	assert.equal(view.urgent, false);
	assert.deepEqual(
		listed.totals.map((total) => [total.currency, total.monthlyMinor, total.paidLast12MonthsMinor]),
		[["USD", 1799, 1799]],
	);

	const [activity] = await labels(env);
	assert.equal(activity.label, "Started tracking a subscription");
	assert.equal(activity.target.href, `/finance?subscription=${row.id}`);
	assert.match(activity.target.label, /^Streamflix · \$17\.99\/month$/);

	const sent = deliveries().filter((delivery) => delivery.event === "finance.subscription.detected");
	assert.deepEqual(
		sent.map((delivery) => delivery.webhookId),
		["wh-owner"],
		"one delivery, to the owner's webhook only",
	);
	assert.equal(sent[0].body.data.source, "suggestion");
	assert.deepEqual(sent[0].body.data.message, { kind: "mail:message", id: "inv-1" });
	assert.equal(sent[0].body.data.subscription.ref.id, row.id);
});

test("before migration 0063 the list and the detail answer migrationPending without a subscription", async (t) => {
	const context = await setup(t);
	context.db.db.exec("DROP TABLE finance_charges; DROP TABLE finance_subscriptions;");
	assert.deepEqual(await listSubscriptionsView(viewOf(owner), "all"), {
		subscriptions: [],
		totals: [],
		migrationPending: true,
	});
	assert.deepEqual(await subscriptionDetailView(viewOf(owner), "fsub_missing"), { migrationPending: true });
});

test("Undo of Track removes the row and its documents and reopens the card", async (t) => {
	const context = await setup(t);
	const { env, rows, documents, suggestion } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	await undoAgentAction(env, owner, first.actionId);
	assert.deepEqual(rows(), []);
	assert.deepEqual(documents(), []);
	assert.equal(suggestion("sugg-1").status, "open");
	assert.equal(await subscriptionDetailView(viewOf(owner), subscriptionId), null);
	const listed = await listSubscriptionsView(viewOf(owner), null);
	assert.deepEqual(listed, { subscriptions: [], totals: [] });
	const [undo] = await labels(env);
	assert.equal(undo.label.startsWith("Undid"), true, undo.label);
	const [ref] = await resolveRecordRefs(env, { userId: "owner", role: "user", isPrimaryAdmin: false }, [
		{ kind: "finance:subscription", id: subscriptionId },
	]);
	assert.equal(ref.unavailable, true);
	await undoAgentAction(env, owner, first.actionId).catch(() => undefined);
	assert.deepEqual(rows(), [], "a second undo changes nothing");
});

test("a later invoice at a new price updates the row, flags the change and its undo removes only its own document", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents, suggestion, deliveries } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	const originalRenewal = rows()[0].next_renewal_at;
	addCard(
		"sugg-2",
		"inv-2",
		card({
			event: "price_change",
			subscriptionId,
			amountMinor: 1999,
			previousAmountMinor: 1799,
			nextRenewalOn: day(50),
			document: {
				docType: "invoice",
				documentOn: day(-10),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: "invoice-2",
			},
		}),
	);
	const update = await accept(env, "sugg-2");
	assert.notEqual(update.actionId, first.actionId);
	assert.equal(update.subscription.id, subscriptionId);
	const [row] = rows();
	assert.equal(rows().length, 1);
	assert.equal(row.amount_minor, 1999);
	assert.equal(row.previous_amount_minor, 1799);
	assert.ok(row.price_changed_at);
	assert.notEqual(row.next_renewal_at, originalRenewal);
	assert.equal(row.last_message_id, "inv-2");
	assert.deepEqual(
		documents().map((document) => [document.message_id, document.doc_type, document.attachment_id]),
		[
			["inv-1", "invoice", null],
			["inv-2", "invoice", "invoice-2"],
		],
	);
	const [activity] = await labels(env);
	assert.equal(activity.label, "Updated a tracked subscription from a new invoice");
	assert.equal(
		deliveries().filter((delivery) => delivery.webhookId === "wh-owner").length,
		1,
		"an update of an existing row emits no detected event",
	);
	const detail = await subscriptionDetailView(viewOf(owner), subscriptionId);
	assert.equal(detail.subscription.previousAmountMinor, 1799);
	assert.deepEqual(detail.paidLast12Months, [{ currency: "USD", minor: 3798 }]);
	assert.equal(detail.documents[0].message.id, "inv-2");
	assert.equal(detail.documents[0].attachmentId, "invoice-2");

	await undoAgentAction(env, owner, update.actionId);
	const [restored] = rows();
	assert.equal(restored.amount_minor, 1799);
	assert.equal(restored.previous_amount_minor, null);
	assert.equal(restored.price_changed_at, null);
	assert.equal(restored.next_renewal_at, originalRenewal);
	assert.equal(restored.last_message_id, "inv-1");
	assert.deepEqual(
		documents().map((document) => document.message_id),
		["inv-1"],
	);
	assert.equal(suggestion("sugg-2").status, "open", "the price-change card reopens");
	assert.equal(suggestion("sugg-1").status, "accepted");
});

test("a same-price renewal and a second card for an untracked vendor update the row; an invoice ends a trial", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents } = context;
	addCard("sugg-a", "inv-a", card({ event: "trial", trialEndsOn: day(10), document: null }));
	addCard("sugg-b", "inv-b", card({ nextRenewalOn: day(30) }));
	const tracked = await accept(env, "sugg-a");
	assert.equal(rows()[0].status, "trial");
	const second = await accept(env, "sugg-b");
	assert.equal(rows().length, 1, "the second card is matched again and updates the row");
	assert.equal(second.subscription.id, tracked.subscription.id);
	assert.equal(rows()[0].status, "active", "an invoice moves a trial to active");
	const actions = context.db.db
		.prepare("SELECT action, variant FROM agent_actions WHERE status = 'applied' ORDER BY rowid")
		.all();
	assert.deepEqual(
		actions.map((action) => `${action.action}:${action.variant}`),
		["create_subscription:", "create_subscription:update"],
	);
	addCard(
		"sugg-c",
		"inv-c",
		card({
			event: "renewal",
			subscriptionId: tracked.subscription.id,
			nextRenewalOn: day(60),
			document: { docType: "invoice", documentOn: day(-1), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	await accept(env, "sugg-c");
	assert.equal(rows().length, 1);
	assert.equal(rows()[0].next_renewal_at, Date.parse(`${day(60)}T00:00:00Z`) / 1000);
	assert.equal(rows()[0].previous_amount_minor, null, "the same price flags nothing");
	assert.equal(documents().length, 2);
});

test("a refund is recorded without changing the subscription and lowers the 12-month total; undo restores it", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents, suggestion } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	addCard(
		"sugg-2",
		"inv-2",
		card({
			event: "price_change",
			subscriptionId,
			amountMinor: 1999,
			previousAmountMinor: 1799,
			document: {
				docType: "invoice",
				documentOn: day(-10),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: null,
			},
		}),
	);
	await accept(env, "sugg-2");
	const paid = async () => (await listSubscriptionsView(viewOf(owner), null)).totals[0].paidLast12MonthsMinor;
	assert.equal(await paid(), 3798);
	const before = rows()[0];
	addCard(
		"sugg-r",
		"refund-1",
		card({
			event: "refund",
			subscriptionId,
			amountMinor: 1999,
			document: { docType: "refund", documentOn: day(-2), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	await assert.rejects(() => accept(env, "sugg-r", "track"), { status: 400 });
	const recorded = await accept(env, "sugg-r", "record");
	assert.equal(recorded.documentRecorded, true);
	assert.equal(await paid(), 1799);
	const after = rows()[0];
	for (const column of ["amount_minor", "next_renewal_at", "status", "last_message_id", "cycle", "trial_ends_at"])
		assert.equal(after[column], before[column], column);
	assert.equal(documents().filter((document) => document.doc_type === "refund").length, 1);
	assert.equal((await labels(env))[0].label, "Recorded a refund");
	await undoAgentAction(env, owner, recorded.actionId);
	assert.equal(await paid(), 3798);
	assert.equal(documents().filter((document) => document.doc_type === "refund").length, 0);
	assert.equal(suggestion("sugg-r").status, "open");

	addCard(
		"sugg-credit",
		"credit-1",
		card({
			event: "refund",
			subscriptionId,
			amountMinor: 500,
			document: { docType: "credit", documentOn: day(-1), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	await accept(env, "sugg-credit", "record");
	assert.equal(await paid(), 3298);
	assert.equal((await labels(env))[0].label, "Recorded a credit note");
});

test("a failed payment is urgent only after the click and a later payment clears it", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	addCard(
		"sugg-f",
		"failed-1",
		card({
			event: "payment_failed",
			subscriptionId,
			amountMinor: null,
			currency: null,
			document: {
				docType: "failed_payment",
				documentOn: day(-1),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: null,
			},
		}),
	);
	const urgent = async () => (await listSubscriptionsView(viewOf(owner), null)).subscriptions[0].urgent;
	assert.equal(await urgent(), false, "nothing changes before the click");
	const marked = await accept(env, "sugg-f", "mark_urgent");
	assert.equal(await urgent(), true);
	assert.equal(documents().filter((document) => document.doc_type === "failed_payment").length, 1);
	const { totals } = await listSubscriptionsView(viewOf(owner), null);
	assert.equal(totals[0].paidLast12MonthsMinor, 1799, "a failed payment never counts");
	assert.equal((await labels(env))[0].label, "Marked a subscription payment as failed");
	await undoAgentAction(env, owner, marked.actionId);
	assert.equal(await urgent(), false);
	assert.equal(documents().filter((document) => document.doc_type === "failed_payment").length, 0);

	await accept(env, "sugg-f", "mark_urgent");
	assert.equal(await urgent(), true);
	addCard(
		"sugg-p",
		"payment-1",
		card({
			event: "renewal",
			subscriptionId,
			document: { docType: "payment", documentOn: day(0), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	const paid = await accept(env, "sugg-p");
	assert.equal(await urgent(), false, "a later payment clears the failed payment");
	await undoAgentAction(env, owner, paid.actionId);
	assert.equal(await urgent(), true, "undoing the payment puts the failed payment back");
	assert.equal(rows().length, 1);
});

test("only the reviewer decides; stale cards, unfit options and stale attachments are refused or dropped", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents } = context;
	addCard(
		"sugg-1",
		"inv-1",
		card({
			document: {
				docType: "invoice",
				documentOn: day(-3),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: "gone",
			},
		}),
	);
	context.db.db.prepare("DELETE FROM message_attachments WHERE id = 'gone'").run();
	await assert.rejects(() => accept(env, "sugg-1", "track", member), { status: 404 });
	assert.equal(rows().length, 0);
	await assert.rejects(() => accept(env, "sugg-1", "mark_urgent"), { status: 400 });
	await assert.rejects(() => accept(env, "sugg-1", "nonsense"), { status: 400 });
	await accept(env, "sugg-1");
	assert.equal(documents().length, 1, "the document is still recorded");
	assert.equal(documents()[0].attachment_id, null, "without the attachment the message no longer has");
	addCard("sugg-old", "inv-old", card(), "dismissed");
	await assert.rejects(() => accept(env, "sugg-old"), { status: 409 });
	addCard(
		"sugg-orphan",
		"refund-orphan",
		card({
			event: "refund",
			subscriptionId: "fsub_missing",
			vendorKey: "other.example",
			document: { docType: "refund", documentOn: day(-1), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	await assert.rejects(() => accept(env, "sugg-orphan", "record"), { status: 409 });
	assert.equal(context.suggestion("sugg-orphan").status, "open");
});

test("a document already recorded for that message is not inserted twice", async (t) => {
	const context = await setup(t);
	const { env, addCard, documents, db } = context;
	const first = await trackFirst(context);
	addCard(
		"sugg-2",
		"inv-2",
		card({
			event: "renewal",
			subscriptionId: first.subscription.id,
			document: { docType: "invoice", documentOn: day(-5), periodStartOn: null, periodEndOn: null, attachmentId: null },
		}),
	);
	db.db
		.prepare(
			"INSERT INTO finance_charges (id, subscription_id, user_id, message_id, doc_type, amount_minor, currency, document_at, created_at) VALUES ('fdoc_hand', ?, 'owner', 'inv-2', 'invoice', 1799, 'USD', 1, 1)",
		)
		.run(first.subscription.id);
	const update = await accept(env, "sugg-2");
	assert.equal(update.documentRecorded, false);
	assert.deepEqual(
		documents().map((document) => document.id),
		["fdoc_hand", `fdoc_${first.actionId.replace(/^aact_/, "")}`],
	);
	await undoAgentAction(env, owner, update.actionId);
	assert.equal(documents().length, 2, "undo leaves the document it did not insert");
});

test("subscriptions, documents and refs are the owner's only", async (t) => {
	const context = await setup(t);
	const { env } = context;
	const first = await trackFirst(context);
	const id = first.subscription.id;
	assert.equal(await subscriptionDetailView(viewOf(member), id), null);
	assert.deepEqual((await listSubscriptionsView(viewOf(member), null)).subscriptions, []);
	const refs = [{ kind: "finance:subscription", id }];
	const [mine] = await resolveRecordRefs(env, { userId: "owner", role: "user", isPrimaryAdmin: false }, refs);
	assert.equal(mine.label, "Streamflix · $17.99/month");
	assert.equal(mine.href, `/finance?subscription=${id}`);
	const [theirs] = await resolveRecordRefs(env, { userId: "member", role: "user", isPrimaryAdmin: false }, refs);
	assert.equal(theirs.unavailable, true);
	const [missing] = await resolveRecordRefs(env, { userId: "owner", role: "user", isPrimaryAdmin: false }, [
		{ kind: "finance:subscription", id: "fsub_missing" },
	]);
	assert.equal(missing.unavailable, true);
	const call = {
		op: "undo",
		actionId: first.actionId,
		inverse: { inverse: { userId: "owner", subscriptionId: id, created: true } },
	};
	const ctx = {
		viewer: { userId: "member", role: "user", isPrimaryAdmin: false },
		requestId: "r",
		locale: "en",
		timeZone: "UTC",
		grants: ["finance.write"],
		trigger: "api",
	};
	const refused = await invokeCapability("finance", "trackSubscription", call, ctx);
	assert.equal(refused.ok, true);
	assert.equal(refused.output.refused.status, 403, "only the owner can undo");
	assert.equal(context.rows().length, 1);
});

const readCtx = (userId) => ({
	viewer: { userId, role: "user", isPrimaryAdmin: false },
	requestId: "r",
	locale: "en",
	timeZone: "UTC",
	grants: ["finance.read"],
	trigger: "mcp",
});

test("search and list_subscriptions answer with the owner's rows only and stop while Money Watch is off", async (t) => {
	const context = await setup(t);
	const { db } = context;
	const first = await trackFirst(context);
	const id = first.subscription.id;
	db.db.prepare("UPDATE finance_subscriptions SET plan = '50%_Family' WHERE id = ?").run(id);

	const search = (userId, query, limit = 20) =>
		invokeCapability("finance", "search", { query, limit }, readCtx(userId));
	const found = await search("owner", "flix");
	assert.equal(found.ok, true, JSON.stringify(found));
	assert.deepEqual(found.output.items, [
		{
			ref: { kind: "finance:subscription", id },
			label: "Streamflix · $17.99/month",
			sublabel: `50%_Family · Renews ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day(20)}T00:00:00Z`))}`,
			href: `/finance?subscription=${id}`,
		},
	]);
	assert.equal((await search("owner", "%_f")).output.items.length, 1, "% and _ match themselves");
	assert.deepEqual((await search("owner", "x%y")).output.items, [], "% is not a wildcard");
	assert.deepEqual((await search("owner", "s_reamflix")).output.items, [], "_ is not a wildcard");
	assert.deepEqual((await search("member", "flix")).output.items, [], "another user finds nothing");
	for (let index = 0; index < 12; index += 1)
		db.db
			.prepare(
				"INSERT INTO finance_subscriptions (id, user_id, vendor, vendor_key, status, reminder_days, created_at, updated_at) VALUES (?, 'owner', ?, ?, 'active', 3, 1, 1)",
			)
			.run(`fsub_many_${index}`, `Manyflix ${index}`, `many${index}.example`);
	assert.equal((await search("owner", "flix")).output.items.length, 10, "at most 10 rows");

	const list = (userId, input = {}) => invokeCapability("finance", "list_subscriptions", input, readCtx(userId));
	const mine = await list("owner", { limit: 1 });
	assert.equal(mine.ok, true, JSON.stringify(mine));
	assert.deepEqual(mine.output.subscriptions, [
		{
			ref: { kind: "finance:subscription", id },
			vendor: "Streamflix",
			plan: "50%_Family",
			amount: { minor: 1799, currency: "USD" },
			cycle: "monthly",
			status: "active",
			nextRenewalOn: day(20),
			trialEndsOn: null,
			urgent: false,
		},
	]);
	assert.deepEqual(mine.output.totals, [
		{ currency: "USD", monthlyMinor: 1799, yearlyMinor: 21588, paidLast12MonthsMinor: 1799 },
	]);
	assert.equal((await list("owner")).output.subscriptions.length, 13, "limit defaults to 20");
	assert.equal((await list("owner", { dueWithinDays: 30 })).output.subscriptions.length, 1);
	assert.deepEqual((await list("owner", { status: "cancelled" })).output.subscriptions, []);
	assert.deepEqual(await list("member").then((result) => result.output), { subscriptions: [], totals: [] });
	for (const input of [{ limit: 51 }, { limit: 0 }, { dueWithinDays: 0 }, { dueWithinDays: 367 }, { status: "paused" }])
		assert.equal((await list("owner", input)).error?.code, "invalid_input", JSON.stringify(input));
	const noGrant = await invokeCapability("finance", "list_subscriptions", {}, { ...readCtx("owner"), grants: [] });
	assert.equal(noGrant.ok, false, "the key needs mcp:finance-read");

	db.db.exec(
		"INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES ('finance', 'finance', 0, 1) ON CONFLICT (module_id) DO UPDATE SET enabled = 0",
	);
	clearModuleStateCache();
	assert.equal((await list("owner")).error?.code, "module_disabled");
	assert.equal((await search("owner", "flix")).error?.code, "module_disabled");
	db.db.exec("UPDATE module_settings SET enabled = 1 WHERE module_id = 'finance'");
	clearModuleStateCache();
	assert.equal((await list("owner", { limit: 50 })).output.subscriptions.length, 13, "on again lists the same rows");
});

test("the detect step completes a receipt without a cycle from two earlier same-amount messages", async (t) => {
	const context = await setup(t);
	const received = new Date(Date.now() - DAY_MS).toISOString();
	const calls = [];
	const original = moduleHost.mail.recentFromSender;
	moduleHost.mail.recentFromSender = async (_ctx, query) => {
		calls.push(query);
		const earlier = (days) => ({
			id: `older-${days}`,
			mailboxId: "mailbox-a",
			from: "billing@streamflix.example",
			subject: "Your receipt",
			receivedAt: new Date(Date.parse(received) - days * DAY_MS).toISOString(),
			attachments: [],
			textExcerpt: "Amount paid: $12.00",
		});
		return [earlier(30), earlier(60)];
	};
	t.after(() => {
		moduleHost.mail.recentFromSender = original;
	});
	const input = {
		message: {
			id: "receipt-1",
			mailboxId: "mailbox-a",
			from: "billing@streamflix.example",
			fromName: "Streamflix Billing",
			subject: "Your receipt",
			receivedAt: received,
			textExcerpt: "Amount paid: $12.00",
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
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null },
		attachments: [],
		model: null,
	};
	const ctx = {
		viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
		requestId: "r",
		locale: "en",
		timeZone: "UTC",
		grants: ["finance.read"],
		mailboxIds: ["mailbox-a"],
		trigger: "auto_read",
	};
	const result = await invokeCapability("finance", "detect", input, ctx);
	assert.equal(result.ok, true, JSON.stringify(result));
	const [suggestion] = result.output.suggestions;
	assert.equal(suggestion.kind, "subscription");
	assert.ok(suggestion.payload.signals.includes("recurring"));
	assert.equal(suggestion.payload.cycle, "monthly");
	assert.equal(calls.length, 1);
	assert.ok(calls[0].limit <= 5);
	assert.equal(calls[0].sinceDays, 400);
	assert.equal(calls[0].sender, "billing@streamflix.example");
	assert.deepEqual(context.rows(), [], "nothing is stored for an untracked vendor");
	assert.deepEqual(context.documents(), []);
});

function invoicePdf(content) {
	const body = deflateSync(Buffer.from(content, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		body,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
	]);
}

function pdfStepInput(attachments) {
	return {
		message: {
			id: "pdf-1",
			mailboxId: "mailbox-a",
			from: "billing@streamflix.example",
			fromName: "Streamflix Billing",
			subject: "Your Streamflix invoice",
			receivedAt: new Date(Date.now() - DAY_MS).toISOString(),
			textExcerpt: "Hello, your invoice is attached.",
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
		},
		headers: { listUnsubscribe: null, listUnsubscribePost: null, listId: null },
		attachments,
		model: null,
	};
}

const PDF_CTX = {
	viewer: { userId: "owner", role: "user", isPrimaryAdmin: false },
	requestId: "r",
	locale: "en",
	timeZone: "UTC",
	grants: ["finance.read"],
	mailboxIds: ["mailbox-a"],
	trigger: "auto_read",
};

test("the detect step reads an invoice PDF through readAttachment when the body has no amount", async (t) => {
	await setup(t);
	const reads = [];
	const files = {
		"att-plain": invoicePdf("BT (Streamflix Plus) Tj T* ($12.00 per month) Tj ET"),
		"att-locked": Buffer.from("%PDF-1.4\ntrailer << /Encrypt 5 0 R >>\n%%EOF"),
	};
	files["att-big"] = files["att-plain"];
	const original = moduleHost.mail.readAttachment;
	moduleHost.mail.readAttachment = async (_ctx, messageId, attachmentId, options) => {
		reads.push({ messageId, attachmentId, maxBytes: options.maxBytes });
		if (attachmentId === "att-broken") throw new Error("storage unavailable");
		const bytes = files[attachmentId];
		return { encoding: "base64", content: bytes.toString("base64"), truncated: attachmentId === "att-big" };
	};
	t.after(() => {
		moduleHost.mail.readAttachment = original;
	});
	const pdfAttachment = (id, size = 900) => ({
		id,
		contentType: "application/pdf",
		filename: `invoice-${id}.pdf`,
		size,
	});
	const detect = (attachments) => invokeCapability("finance", "detect", pdfStepInput(attachments), PDF_CTX);

	const found = await detect([pdfAttachment("att-plain")]);
	assert.equal(found.ok, true, JSON.stringify(found));
	const [card] = found.output.suggestions;
	assert.equal(card.payload.amountMinor, 1200);
	assert.equal(card.payload.currency, "USD");
	assert.equal(card.payload.cycle, "monthly");
	assert.equal(card.payload.document.attachmentId, "att-plain");
	assert.deepEqual(reads, [{ messageId: "pdf-1", attachmentId: "att-plain", maxBytes: 2_097_152 }]);
	assert.doesNotMatch(JSON.stringify(found.output), /Streamflix Plus/, "the PDF text is not handed back");

	for (const id of ["att-locked", "att-broken", "att-big"]) {
		const skipped = await detect([pdfAttachment(id)]);
		assert.equal(skipped.ok, true, `${id}: ${JSON.stringify(skipped)}`);
		assert.deepEqual(skipped.output.suggestions, [], id);
	}
	reads.length = 0;
	const oversized = await detect([pdfAttachment("att-huge", 2_097_153)]);
	assert.deepEqual(oversized.output.suggestions, []);
	const image = await detect([{ id: "img", contentType: "image/png", filename: "invoice.png", size: 900 }]);
	assert.deepEqual(image.output.suggestions, []);
	assert.deepEqual(reads, [], "oversized PDFs and images are never read");
});

function actionCtx(userId = "owner") {
	return {
		viewer: { userId, role: "user", isPrimaryAdmin: false },
		requestId: "r",
		locale: "en",
		timeZone: "UTC",
		grants: ["finance.write"],
		trigger: "api",
	};
}

async function runAction(name, call, userId = "owner") {
	const result = await invokeCapability("finance", name, call, actionCtx(userId));
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.output;
}

const suggestionRef = { id: null, messageId: null, mailboxId: "mailbox-a" };

test("removal actions refuse missing, mismatched or another owner's snapshots without deleting rows", async (t) => {
	const context = await setup(t);
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	const before = await subscriptionRemovalSnapshot(await ownerRow("owner", subscriptionId));
	const input = { subscriptionId };
	for (const name of ["deleteSubscription", "deleteDocument"]) {
		const result = await runAction(name, {
			op: "execute",
			actionId: "aact_no_snapshot",
			suggestion: suggestionRef,
			input: name === "deleteSubscription" ? input : { documentId: context.documents()[0].id },
		});
		assert.equal(result.refused.status, 409);
	}
	const mismatched = await runAction("deleteSubscription", {
		op: "execute",
		actionId: "aact_wrong_snapshot",
		suggestion: suggestionRef,
		input: { subscriptionId: "another" },
		before,
	});
	assert.equal(mismatched.refused.status, 409);
	const stranger = await runAction(
		"deleteSubscription",
		{ op: "execute", actionId: "aact_foreign_snapshot", suggestion: suggestionRef, input, before },
		"member",
	);
	assert.equal(stranger.refused.status, 403);
	assert.equal(context.rows().length, 1);
	assert.equal(context.documents().length, 1);
});

test("each action is idempotent by actionId and undoes only what it did", async (t) => {
	const context = await setup(t);
	const { rows, documents } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	const execute = async (name, actionId, input) => {
		const before =
			name === "deleteSubscription"
				? await subscriptionRemovalSnapshot(await ownerRow("owner", input.subscriptionId))
				: name === "deleteDocument"
					? documentRemovalSnapshot(await documentRow("owner", input.documentId))
					: undefined;
		return runAction(name, {
			op: "execute",
			actionId,
			suggestion: suggestionRef,
			input,
			...(before ? { before } : {}),
		});
	};
	const undo = (name, actionId, inverse, op = "undo") => runAction(name, { op, actionId, inverse: { inverse } });

	const edit = { variant: "", subscriptionId, changes: { vendor: "Streamflix Plus", amountMinor: 2499 } };
	const edited = await execute("editSubscription", "aact_edit", edit);
	assert.deepEqual(edited.inverse.previous, { vendor: "Streamflix", amountMinor: 1799 });
	assert.equal(rows()[0].vendor, "Streamflix Plus");
	await undo("editSubscription", "aact_edit", edited.inverse);
	await undo("editSubscription", "aact_edit", edited.inverse);
	assert.equal(rows()[0].vendor, "Streamflix");
	assert.equal(rows()[0].amount_minor, 1799);
	const refused = await runAction("editSubscription", {
		op: "execute",
		actionId: "aact_bad",
		suggestion: suggestionRef,
		input: { variant: "reminder", subscriptionId, changes: { vendor: "Nope" } },
	});
	assert.equal(refused.refused.status, 409, "a variant cannot change fields outside its own");

	const status = await execute("setSubscriptionStatus", "aact_status", { variant: "cancelled", subscriptionId });
	assert.equal(rows()[0].status, "cancelled");
	await undo("setSubscriptionStatus", "aact_status", status.inverse);
	assert.equal(rows()[0].status, "active");

	const document = {
		docType: "payment",
		documentOn: day(-3),
		periodStartOn: null,
		periodEndOn: null,
		attachmentId: null,
		amountMinor: 1799,
		currency: "USD",
	};
	context.addMessage("pay-hand");
	const record = { variant: "payment", subscriptionId, messageId: "pay-hand", document };
	const recorded = await execute("recordDocument", "aact_pay", record);
	const again = await execute("recordDocument", "aact_pay", record);
	assert.equal(recorded.result.documentRecorded, true);
	assert.equal(again.result.documentId, recorded.result.documentId, "a resumed action finds its own document");
	assert.equal(documents().length, 2);
	const duplicate = await execute("recordDocument", "aact_pay_2", record);
	assert.equal(duplicate.result.documentRecorded, false, "one document per subscription, message and type");
	assert.equal(documents().length, 2);
	await undo("recordDocument", "aact_pay_2", duplicate.inverse);
	assert.equal(documents().length, 2, "undoing the duplicate removes nothing");

	const removed = await execute("deleteDocument", "aact_deldoc", { documentId: recorded.result.documentId });
	assert.equal(documents().length, 1);
	await undo("deleteDocument", "aact_deldoc", removed.inverse);
	await undo("deleteDocument", "aact_deldoc", removed.inverse);
	assert.ok(
		documents().some((row) => row.id === recorded.result.documentId),
		"re-inserted with the same id",
	);

	const snapshot = documents();
	const gone = await execute("deleteSubscription", "aact_delsub", { subscriptionId });
	assert.deepEqual(rows(), []);
	assert.deepEqual(documents(), []);
	const authorized = await undo("deleteSubscription", "aact_delsub", gone.inverse, "authorize_undo");
	assert.equal(authorized.refused, undefined);
	assert.deepEqual(rows(), [], "authorizing changes nothing");
	const stranger = await runAction(
		"deleteSubscription",
		{ op: "authorize_undo", actionId: "aact_delsub", inverse: { inverse: gone.inverse } },
		"member",
	);
	assert.equal(stranger.refused.status, 403);
	await undo("deleteSubscription", "aact_delsub", gone.inverse);
	await undo("deleteSubscription", "aact_delsub", gone.inverse);
	assert.equal(rows().length, 1);
	assert.equal(rows()[0].id, subscriptionId);
	assert.deepEqual(documents(), snapshot, "documents come back with their ids");

	const missing = await execute("recordDocument", "aact_missing", { ...record, subscriptionId: "fsub_missing" });
	assert.equal(missing.refused.status, 409);
});

test("undoing a removal after its source message, contact and attachment were purged restores the history unlinked", async (t) => {
	const context = await setup(t);
	const { db, rows, documents } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	assert.equal(rows()[0].source_message_id, "inv-1");
	assert.equal(rows()[0].contact_id, "contact-1");
	const record = (actionId, messageId, attachmentId = null) =>
		runAction("recordDocument", {
			op: "execute",
			actionId,
			suggestion: suggestionRef,
			input: {
				variant: "payment",
				subscriptionId,
				messageId,
				document: {
					docType: "payment",
					documentOn: day(-3),
					periodStartOn: null,
					periodEndOn: null,
					attachmentId,
					amountMinor: 1799,
					currency: "USD",
				},
			},
		});
	context.addMessage("pay-gone", { attachments: ["att-gone"] });
	context.addMessage("pay-keep");
	const gone = await record("aact_pay_gone", "pay-gone", "att-gone");
	const kept = await record("aact_pay_keep", "pay-keep");
	const purge = (id) => db.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
	const documentOf = (id) => documents().find((row) => row.id === id);
	const storedGone = documentOf(gone.result.documentId);
	assert.equal(storedGone.attachment_id, "att-gone");

	const removedDocument = await runAction("deleteDocument", {
		op: "execute",
		actionId: "aact_deldoc_purged",
		suggestion: suggestionRef,
		input: { documentId: gone.result.documentId },
		before: documentRemovalSnapshot(await documentRow("owner", gone.result.documentId)),
	});
	purge("pay-gone");
	const undone = await runAction("deleteDocument", {
		op: "undo",
		actionId: "aact_deldoc_purged",
		inverse: { inverse: removedDocument.inverse },
	});
	assert.equal(undone.refused, undefined);
	assert.deepEqual(
		documentOf(gone.result.documentId),
		{ ...storedGone, message_id: null },
		"the document returns with the same id and amount, without its purged message",
	);

	const totalBefore = (await subscriptionDetailView(viewOf(owner), subscriptionId)).subscription;
	const snapshot = await subscriptionRemovalSnapshot(await ownerRow("owner", subscriptionId));
	const removedSubscription = await runAction("deleteSubscription", {
		op: "execute",
		actionId: "aact_delsub_purged",
		suggestion: suggestionRef,
		input: { subscriptionId },
		before: snapshot,
	});
	assert.deepEqual(rows(), []);
	purge("inv-1");
	db.db.prepare("DELETE FROM contacts WHERE id = 'contact-1'").run();
	await runAction("deleteSubscription", {
		op: "undo",
		actionId: "aact_delsub_purged",
		inverse: { inverse: removedSubscription.inverse },
	});
	const [restored] = rows();
	assert.equal(restored.id, subscriptionId);
	assert.equal(restored.source_message_id, null);
	assert.equal(restored.last_message_id, null);
	assert.equal(restored.contact_id, null);
	assert.equal(restored.mailbox_id, "mailbox-a", "a reference that still exists is kept");
	assert.equal(restored.amount_minor, 1799);
	assert.equal(documents().length, 3, "every document comes back");
	const invoice = documents().find((row) => ![gone.result.documentId, kept.result.documentId].includes(row.id));
	assert.equal(invoice.message_id, null);
	assert.equal(documentOf(kept.result.documentId).message_id, "pay-keep", "a live message link is kept");
	assert.equal(documentOf(gone.result.documentId).attachment_id, "att-gone");
	const detail = await subscriptionDetailView(viewOf(owner), subscriptionId);
	assert.deepEqual(
		detail.subscription,
		{ ...totalBefore, sourceMessageId: null, lastMessageId: null, contactId: null },
		"totals and fields are as before the removal, without the purged links",
	);
});

test("Track by hand creates the row once, emits a manual event, and undo removes it", async (t) => {
	const context = await setup(t);
	const { rows, deliveries } = context;
	const input = {
		variant: "",
		fields: {
			vendor: "Gym",
			plan: null,
			amountMinor: 4000,
			currency: "EUR",
			cycle: "monthly",
			nextRenewalOn: day(5),
			renewalEstimated: false,
			trialEndsOn: null,
			status: "active",
			paymentFailedAt: null,
			reminderDays: 7,
			calendarReminder: false,
			cancelUrl: null,
			cancelOneClick: false,
			previousAmountMinor: null,
			priceChangedAt: null,
			lastMessageId: null,
		},
		vendorKey: "gym.example",
		mailboxId: "mailbox-a",
		contactId: null,
		messageId: null,
		source: "manual",
		document: null,
	};
	const call = { op: "execute", actionId: "aact_manual", suggestion: suggestionRef, input };
	const created = await runAction("trackSubscription", call);
	const resumed = await runAction("trackSubscription", call);
	assert.equal(created.result.created, true);
	assert.equal(resumed.result.created, false);
	assert.equal(rows().length, 1);
	const sent = deliveries().filter((delivery) => delivery.webhookId === "wh-owner");
	assert.equal(sent.length, 1, "a resumed action does not emit again");
	assert.equal(sent[0].body.data.source, "manual");
	assert.equal(sent[0].body.data.message, null);
	await runAction("trackSubscription", { op: "undo", actionId: "aact_manual", inverse: { inverse: created.inverse } });
	assert.deepEqual(rows(), []);
});

const liveActions = (db) =>
	db.db
		.prepare("SELECT action, variant FROM agent_actions WHERE status IN ('pending', 'applied') ORDER BY rowid")
		.all()
		.map((action) => `${action.action}:${action.variant}`);

test("concurrent and repeated Track clicks on one card reach one action and never an update", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, suggestion, db } = context;
	addCard("sugg-1", "inv-1", card());
	const settled = await Promise.allSettled([accept(env, "sugg-1"), accept(env, "sugg-1")]);
	for (const outcome of settled) if (outcome.status === "rejected") assert.equal(outcome.reason.status, 409);
	const actionIds = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.actionId] : []));
	assert.ok(actionIds.length > 0);
	assert.equal(new Set(actionIds).size, 1, "both clicks hand back the same action");
	assert.deepEqual(liveActions(db), ["create_subscription:"]);
	assert.equal(rows().length, 1);

	// Between the row being written and the card being decided, the card still reads open.
	db.db.prepare("UPDATE agent_suggestions SET status = 'open' WHERE id = 'sugg-1'").run();
	const again = await accept(env, "sugg-1");
	assert.equal(again.actionId, actionIds[0]);
	assert.deepEqual(liveActions(db), ["create_subscription:"], "no update action");
	assert.equal(rows().length, 1);

	await undoAgentAction(env, owner, actionIds[0]);
	assert.deepEqual(rows(), []);
	assert.equal(suggestion("sugg-1").status, "open");
});

/** Puts an applied card action back as a pending row left by a crash before it was marked applied. */
function crashBeforeApplied(db, actionId, suggestionId, before) {
	const stale = Math.floor(Date.now() / 1000) - 3600;
	db.db
		.prepare(
			"UPDATE agent_actions SET status = 'pending', before = ?, after = '{}', undo_until = NULL, updated_at = ? WHERE id = ?",
		)
		.run(JSON.stringify(before), stale, actionId);
	db.db.prepare("UPDATE agent_suggestions SET status = 'open' WHERE id = ?").run(suggestionId);
}

function recordBefore(t) {
	const seen = [];
	const execute = moduleHost.actions.execute;
	moduleHost.actions.execute = (ctx, moduleId, call) => {
		seen.push(call.before);
		return execute(ctx, moduleId, call);
	};
	t.after(() => {
		moduleHost.actions.execute = execute;
	});
	return seen;
}

test("a resumed card action still undoes back to the row before its first run", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents, db } = context;
	const first = await trackFirst(context);
	const subscriptionId = first.subscription.id;
	const original = rows()[0];
	const seen = recordBefore(t);
	addCard(
		"sugg-2",
		"inv-2",
		card({
			event: "price_change",
			subscriptionId,
			amountMinor: 1999,
			previousAmountMinor: 1799,
			nextRenewalOn: day(50),
			document: {
				docType: "invoice",
				documentOn: day(-10),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: null,
			},
		}),
	);
	const update = await accept(env, "sugg-2");
	crashBeforeApplied(db, update.actionId, "sugg-2", seen.at(-1));
	const replay = await accept(env, "sugg-2");
	assert.equal(replay.actionId, update.actionId, "the stale pending row is resumed");
	assert.equal(rows()[0].amount_minor, 1999);
	assert.equal(documents().length, 2, "the resumed run inserts no second document");
	await undoAgentAction(env, owner, update.actionId);
	const restored = rows()[0];
	for (const column of [
		"amount_minor",
		"previous_amount_minor",
		"price_changed_at",
		"next_renewal_at",
		"last_message_id",
		"payment_failed_at",
	])
		assert.equal(restored[column], original[column], column);
	assert.equal(restored.amount_minor, 1799);
	assert.equal(restored.previous_amount_minor, null);
	assert.deepEqual(
		documents().map((document) => document.message_id),
		["inv-1"],
	);

	addCard(
		"sugg-f",
		"failed-1",
		card({
			event: "payment_failed",
			subscriptionId,
			amountMinor: null,
			currency: null,
			document: {
				docType: "failed_payment",
				documentOn: day(-1),
				periodStartOn: null,
				periodEndOn: null,
				attachmentId: null,
			},
		}),
	);
	const marked = await accept(env, "sugg-f", "mark_urgent");
	assert.ok(rows()[0].payment_failed_at);
	crashBeforeApplied(db, marked.actionId, "sugg-f", seen.at(-1));
	const remarked = await accept(env, "sugg-f", "mark_urgent");
	assert.equal(remarked.actionId, marked.actionId);
	await undoAgentAction(env, owner, marked.actionId);
	assert.equal(rows()[0].payment_failed_at, null, "undo clears the failed payment the first run set");
	assert.equal(documents().filter((document) => document.doc_type === "failed_payment").length, 0);
});

test("the executor hands a resumed module action the before saved with its pending row", async (t) => {
	const context = await setup(t);
	const { env, db } = context;
	const first = await trackFirst(context);
	const id = first.subscription.id;
	const stale = Math.floor(Date.now() / 1000) - 3600;
	db.db
		.prepare(
			"INSERT INTO agent_actions (id, mailbox_id, suggestion_id, initiator, acting_user_id, action, variant, status, before, after, created_at, updated_at) VALUES ('aact_resume', 'mailbox-a', 'sugg-1', 'user', 'owner', 'update_subscription', '', 'pending', ?, '{}', ?, ?)",
		)
		.run(JSON.stringify({ id, userId: "owner", vendor: "Saved before" }), stale, stale);
	const result = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		action: "update_subscription",
		initiator: "user",
		actingUserId: "owner",
		permissions: { canManage: true, canSendOnBehalf: true },
		module: {
			input: { variant: "", subscriptionId: id, changes: { vendor: "Renamed" }, previous: { vendor: "From input" } },
			before: { id, userId: "owner", vendor: "From the new caller" },
			viewer: viewOf(owner),
		},
	});
	assert.equal(result.status, "applied", result.reason);
	assert.equal(result.actionId, "aact_resume");
	const stored = db.db.prepare("SELECT before FROM agent_actions WHERE id = 'aact_resume'").get();
	assert.deepEqual(JSON.parse(stored.before).previous, { vendor: "Saved before" });
});

const handTracked = (vendorKey) => ({
	op: "execute",
	actionId: "aact_hand",
	suggestion: suggestionRef,
	input: {
		variant: "",
		fields: {
			vendor: "Streamflix",
			plan: "Family",
			amountMinor: 2999,
			currency: "USD",
			cycle: "monthly",
			nextRenewalOn: day(5),
			renewalEstimated: false,
			trialEndsOn: null,
			status: "active",
			paymentFailedAt: null,
			reminderDays: 3,
			calendarReminder: false,
			cancelUrl: null,
			cancelOneClick: false,
			previousAmountMinor: null,
			priceChangedAt: null,
			lastMessageId: null,
		},
		vendorKey,
		mailboxId: "mailbox-a",
		contactId: null,
		messageId: null,
		source: "manual",
		document: null,
	},
});

test("refund and failed-payment cards whose row was removed answer 409 instead of matching another row", async (t) => {
	const context = await setup(t);
	const { env, addCard, rows, documents, suggestion, db } = context;
	const first = await trackFirst(context);
	const removedId = first.subscription.id;
	await runAction("trackSubscription", handTracked("streamflix.example"));
	const refund = { docType: "refund", documentOn: day(-2), periodStartOn: null, periodEndOn: null, attachmentId: null };
	addCard("sugg-r", "refund-1", card({ event: "refund", subscriptionId: removedId, document: refund }));
	addCard(
		"sugg-f",
		"failed-1",
		card({
			event: "payment_failed",
			subscriptionId: removedId,
			amountMinor: null,
			currency: null,
			document: { ...refund, docType: "failed_payment" },
		}),
	);
	db.db.prepare("DELETE FROM finance_subscriptions WHERE id = ?").run(removedId);
	const before = documents().length;
	await assert.rejects(() => accept(env, "sugg-r", "record"), { status: 409 });
	await assert.rejects(() => accept(env, "sugg-f", "mark_urgent"), { status: 409 });
	assert.equal(documents().length, before, "no document is written");
	assert.equal(rows().length, 1);
	assert.equal(rows()[0].payment_failed_at, null, "the remaining row is not marked urgent");
	assert.equal(suggestion("sugg-r").status, "open");
	assert.equal(suggestion("sugg-f").status, "open");
});

test("a removal of a subscription with 200 linked documents undoes within D1's bound-parameter limit", async (t) => {
	const context = await setup(t);
	const { rows, documents, db } = context;
	const first = await trackFirst(context);
	const id = first.subscription.id;
	const insert = db.db.prepare(
		"INSERT INTO finance_charges (id, subscription_id, user_id, message_id, doc_type, amount_minor, currency, document_at, created_at) VALUES (?, ?, 'owner', ?, 'invoice', 1799, 'USD', ?, 1)",
	);
	for (let index = 0; index < 199; index += 1) {
		context.addMessage(`bulk-msg-${index}`);
		insert.run(`fdoc_bulk_${index}`, id, `bulk-msg-${index}`, index + 1);
	}
	const before = await subscriptionRemovalSnapshot(await ownerRow("owner", id));
	const removed = await runAction("deleteSubscription", {
		op: "execute",
		actionId: "aact_delsub_bulk",
		suggestion: suggestionRef,
		input: { subscriptionId: id },
		before,
	});
	assert.deepEqual(rows(), []);
	db.db.prepare("DELETE FROM messages WHERE id = 'bulk-msg-0'").run();
	const prepare = db.prepare.bind(db);
	db.prepare = (sql) => {
		assert.ok((sql.match(/\?/g) ?? []).length <= 100, "D1 binds at most 100 parameters per query");
		return prepare(sql);
	};
	t.after(() => {
		db.prepare = prepare;
	});
	await runAction("deleteSubscription", {
		op: "undo",
		actionId: "aact_delsub_bulk",
		inverse: { inverse: removed.inverse },
	});
	assert.equal(rows().length, 1);
	assert.equal(documents().length, 200);
	assert.equal(documents().find((row) => row.id === "fdoc_bulk_0").message_id, null);
	assert.equal(documents().find((row) => row.id === "fdoc_bulk_1").message_id, "bulk-msg-1");
});

test("a subscription with more than 200 documents is not removed", async (t) => {
	const context = await setup(t);
	const { rows, documents, db } = context;
	const first = await trackFirst(context);
	const id = first.subscription.id;
	const insert = db.db.prepare(
		"INSERT INTO finance_charges (id, subscription_id, user_id, doc_type, amount_minor, currency, document_at, created_at) VALUES (?, ?, 'owner', 'invoice', 1799, 'USD', ?, 1)",
	);
	for (let index = 0; index < 200; index += 1) insert.run(`fdoc_bulk_${index}`, id, index + 1);
	assert.equal(documents().length, 201);
	const row = await ownerRow("owner", id);
	await assert.rejects(() => subscriptionRemovalSnapshot(row), /too many documents/);
	assert.equal(rows().length, 1);
	assert.equal(documents().length, 201);
});

const answerUtils = await loadFinance("answer-utils");
const recordUtils = await loadFinance("record-utils");

const DATE = new Date("2026-10-14T09:00:00.000Z");
function storedRow(overrides = {}) {
	return {
		id: "fsub_1",
		userId: "owner",
		mailboxId: "mailbox-a",
		contactId: null,
		vendor: "Streamflix",
		vendorKey: "streamflix.example",
		plan: null,
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		nextRenewalAt: new Date("2026-11-01T00:00:00.000Z"),
		renewalEstimated: false,
		trialEndsAt: null,
		status: "active",
		paymentFailedAt: null,
		reminderDays: 3,
		calendarReminder: true,
		lastRemindedFor: null,
		calendarEventId: null,
		cancelUrl: null,
		cancelOneClick: false,
		previousAmountMinor: null,
		priceChangedAt: null,
		sourceMessageId: "inv-1",
		lastMessageId: "inv-1",
		createdAt: DATE,
		updatedAt: DATE,
		...overrides,
	};
}

test("planAnswer picks the action for each button and refuses what does not fit", () => {
	const { planAnswer, optionFits, isAnswerOption } = answerUtils;
	const row = storedRow();
	const fresh = { suggestionId: "sugg-2" };
	assert.equal(isAnswerOption("track"), true);
	assert.equal(isAnswerOption("toString"), false);
	assert.equal(optionFits("record", "refund"), true);
	assert.equal(optionFits("record", "new"), false);
	assert.deepEqual(planAnswer("track", card(), null, fresh), { capability: "trackSubscription", variant: "" });
	assert.deepEqual(planAnswer("track", card(), row, fresh), { capability: "trackSubscription", variant: "update" });
	assert.deepEqual(
		planAnswer("track", card(), storedRow({ id: "fsub_s_sugg-1" }), { suggestionId: "sugg-1" }),
		{ capability: "trackSubscription", variant: "" },
		"the row this card's own Track created is the same Track, accepted yet or not",
	);
	assert.deepEqual(
		planAnswer("track", card(), row, { suggestionId: "sugg-1" }),
		{ capability: "trackSubscription", variant: "update" },
		"a row added another way from the same message is updated",
	);
	assert.deepEqual(planAnswer("mark_urgent", card({ event: "payment_failed" }), row, fresh), {
		capability: "editSubscription",
		variant: "payment_failed",
	});
	assert.equal(planAnswer("mark_urgent", card({ event: "payment_failed" }), null, fresh).status, 409);
	const refund = card({ event: "refund", document: { ...card().document, docType: "refund" } });
	assert.deepEqual(planAnswer("record", refund, row, fresh), { capability: "recordDocument", variant: "refund" });
	assert.equal(planAnswer("record", card({ event: "refund" }), row, fresh).status, 409);
	assert.equal(planAnswer("record", card({ event: "refund", document: null }), row, fresh).status, 409);
	assert.equal(planAnswer("record", card(), row, fresh).status, 400);
});

test("rowForPayload prefers the named row and otherwise matches again", () => {
	const { rowForPayload } = answerUtils;
	const rows = [storedRow(), storedRow({ id: "fsub_2", plan: "Family", amountMinor: 2999 })];
	assert.equal(rowForPayload(rows, card({ subscriptionId: "fsub_2" })).id, "fsub_2");
	assert.equal(rowForPayload(rows, card({ subscriptionId: "fsub_gone" })).id, "fsub_1");
	assert.equal(rowForPayload(rows, card({ amountMinor: null, currency: null })).id, "fsub_1");
	assert.equal(rowForPayload([], card()), null);
	for (const event of ["refund", "payment_failed"]) {
		assert.equal(rowForPayload(rows, card({ event, subscriptionId: "fsub_gone" })), null, event);
		assert.equal(rowForPayload(rows, card({ event, subscriptionId: "fsub_2" })).id, "fsub_2", event);
	}
});

test("liveDocument drops a stale attachment and documentInput carries the amount", () => {
	const { liveDocument, documentInput } = answerUtils;
	const document = { ...card().document, attachmentId: "att-1" };
	assert.equal(liveDocument(document, ["att-1"]), document);
	assert.equal(liveDocument(document, ["att-2"]).attachmentId, null);
	assert.equal(liveDocument(null, []), null);
	assert.deepEqual(liveDocument(card().document, []), card().document);
	assert.deepEqual(documentInput(card(), card().document), { ...card().document, amountMinor: 1799, currency: "USD" });
	assert.equal(documentInput(card({ amountMinor: null, currency: null }), card().document), null);
	const failed = { ...card().document, docType: "failed_payment" };
	assert.equal(documentInput(card({ amountMinor: null, currency: null }), failed).docType, "failed_payment");
	assert.equal(documentInput(card(), null), null);
});

test("trackUpdate sets what the card read, flags a price change and keeps the earlier values", () => {
	const { trackUpdate, trackedFields } = answerUtils;
	const now = new Date("2026-10-14T10:00:00.000Z");
	const payload = card({
		amountMinor: 1999,
		nextRenewalOn: "2026-12-01",
		renewalEstimated: true,
		trialEndsOn: "2026-10-30",
		cancelLink: { url: "https://streamflix.example/stop", oneClick: true },
	});
	const { changes, previous } = trackUpdate(payload, storedRow({ status: "trial" }), card().document, "inv-2", now);
	assert.equal(changes.amountMinor, 1999);
	assert.equal(changes.previousAmountMinor, 1799);
	assert.equal(changes.priceChangedAt, now.toISOString());
	assert.equal(changes.nextRenewalOn, "2026-12-01");
	assert.equal(changes.renewalEstimated, true);
	assert.equal(changes.trialEndsOn, "2026-10-30");
	assert.equal(changes.cancelUrl, "https://streamflix.example/stop");
	assert.equal(changes.cancelOneClick, true);
	assert.equal(changes.status, "active");
	assert.equal(changes.lastMessageId, "inv-2");
	assert.equal(previous.amountMinor, 1799);
	assert.equal(previous.previousAmountMinor, null);
	assert.equal(previous.nextRenewalOn, "2026-11-01");
	assert.equal(previous.status, "trial");
	const same = trackUpdate(
		card({ nextRenewalOn: null, cycle: null, cancelLink: null }),
		storedRow(),
		null,
		"inv-3",
		now,
	);
	assert.deepEqual(Object.keys(same.changes).sort(), ["amountMinor", "currency", "lastMessageId"]);
	const payment = { ...card().document, docType: "payment" };
	const failed = storedRow({ paymentFailedAt: DATE });
	const cleared = trackUpdate(card({ amountMinor: null, currency: null }), failed, payment, "pay-1", now);
	assert.equal(cleared.changes.paymentFailedAt, null);
	assert.equal(cleared.previous.paymentFailedAt, DATE.toISOString());
	assert.equal(cleared.changes.amountMinor, undefined);
	const otherCurrency = trackUpdate(card({ currency: "EUR" }), storedRow(), null, "inv-4", now);
	assert.equal(otherCurrency.changes.previousAmountMinor, undefined, "a different currency is not a price change");

	const fields = trackedFields(card({ event: "trial", nextRenewalOn: null, renewalEstimated: true }), "inv-1");
	assert.equal(fields.status, "trial");
	assert.equal(fields.renewalEstimated, false);
	assert.equal(fields.reminderDays, 3);
	assert.equal(fields.calendarReminder, true);
	assert.equal(fields.cancelUrl, "https://streamflix.example/cancel");
	const bare = trackedFields(card({ amountMinor: null, cancelLink: null }), "inv-1");
	assert.equal(bare.currency, null);
	assert.equal(bare.cancelUrl, null);
	assert.equal(bare.status, "active");
});

test("record helpers convert fields, rows and filters", () => {
	const {
		snapshotFields,
		fieldColumns,
		subscriptionView,
		webhookSubscription,
		ledgerEntry,
		documentView,
		subscriptionLabel,
		subscriptionHref,
		statusesOf,
		rowJson,
		subscriptionFromJson,
		chargeFromJson,
		derivedId,
		dayToDate,
		dateToDay,
	} = recordUtils;
	const row = storedRow({ paymentFailedAt: DATE, trialEndsAt: new Date("2026-10-20T00:00:00.000Z") });
	assert.deepEqual(snapshotFields(row, ["nextRenewalOn", "paymentFailedAt", "vendor", "trialEndsOn"]), {
		nextRenewalOn: "2026-11-01",
		paymentFailedAt: DATE.toISOString(),
		vendor: "Streamflix",
		trialEndsOn: "2026-10-20",
	});
	assert.deepEqual(
		fieldColumns({ nextRenewalOn: "2026-12-01", priceChangedAt: null, vendor: "X", trialEndsOn: null }),
		{ nextRenewalAt: new Date("2026-12-01T00:00:00.000Z"), priceChangedAt: null, vendor: "X", trialEndsAt: null },
	);
	const view = subscriptionView(row);
	assert.equal(view.urgent, true);
	assert.deepEqual(view.amount, { minor: 1799, currency: "USD" });
	assert.equal(subscriptionView(storedRow({ amountMinor: null, currency: null })).amount, null);
	assert.equal(webhookSubscription(row).nextRenewalOn, "2026-11-01");
	const charge = {
		id: "fdoc_1",
		subscriptionId: "fsub_1",
		userId: "owner",
		messageId: null,
		attachmentId: "att-1",
		docType: "invoice",
		amountMinor: 1799,
		currency: "USD",
		documentAt: new Date("2026-10-01T00:00:00.000Z"),
		periodStartAt: null,
		periodEndAt: null,
		filedRef: null,
		createdAt: DATE,
	};
	assert.equal(ledgerEntry(charge).documentOn, "2026-10-01");
	assert.equal(documentView(charge, true).attachmentId, null, "no attachment without a message");
	assert.equal(documentView(charge, true).paired, true);
	assert.equal(subscriptionLabel(row, "en"), "Streamflix · $17.99/month");
	assert.equal(subscriptionLabel({ ...row, amountMinor: null }, "en"), "Streamflix");
	assert.equal(subscriptionHref("fsub 1"), "/finance?subscription=fsub%201");
	assert.deepEqual(statusesOf("current"), ["active", "trial"]);
	assert.deepEqual(statusesOf("ended"), ["cancelled", "expired"]);
	assert.deepEqual(statusesOf("trial"), ["trial"]);
	assert.deepEqual(statusesOf(null), ["active", "trial", "cancelled", "expired"]);
	assert.deepEqual(statusesOf("bogus"), ["active", "trial", "cancelled", "expired"]);
	assert.deepEqual(subscriptionFromJson(JSON.parse(JSON.stringify(rowJson(row)))), row);
	assert.deepEqual(chargeFromJson(JSON.parse(JSON.stringify(rowJson(charge)))), charge);
	assert.equal(derivedId("fsub", "aact_abc"), "fsub_abc");
	assert.equal(derivedId("fdoc", "other"), "fdoc_other");
	assert.equal(dayToDate(null), null);
	assert.equal(dateToDay(null), null);
});
