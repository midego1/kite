import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-manual-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		manual: join(root, "src/lib/finance/manual.ts"),
		documents: join(root, "src/lib/finance/manual-documents.ts"),
		draft: join(root, "src/lib/finance/draft.ts"),
		api: join(root, "src/lib/agent/auto-read/suggestion-api.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		activity: join(root, "src/lib/agent/auto-read/activity.ts"),
		state: join(root, "src/lib/modules/state.ts"),
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
const { addSubscription, changeSubscription, removeSubscription } = await load("manual");
const { addDocument, removeDocument } = await load("documents");
const { detectDraft } = await load("draft");
const { acceptSuggestion } = await load("api");
const { undoAgentAction } = await load("execute");
const { listAgentActivity } = await load("activity");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY_MS = 86_400_000;
const day = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const SENDER = "Streamflix Billing <billing@streamflix.example>";
const CANCEL = "https://streamflix.example/cancel";

const user = (id, extra = {}) => ({
	id,
	email: `${id}@example.com`,
	role: "user",
	isPrimaryAdmin: false,
	timeZone: "UTC",
	...extra,
});
const owner = user("owner");
const member = user("member");
const boss = user("boss", { role: "admin" });
const lonely = user("lonely");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});

function rawMime(subject, text) {
	return [
		`From: ${SENDER}`,
		"To: support@example.com",
		`Subject: ${subject}`,
		`List-Unsubscribe: <mailto:stop@streamflix.example>, <${CANCEL}>`,
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
		"Content-Type: text/plain",
		"",
		text,
	].join("\r\n");
}

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, role, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'UTC', 'user', 1),
			('member', 'member@example.com', 'hash', 'Member', 'UTC', 'user', 1),
			('boss', 'boss@example.com', 'hash', 'Boss', 'UTC', 'admin', 1),
			('lonely', 'lonely@example.com', 'hash', 'Lonely', 'UTC', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'boss', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-s', 'boss', 'domain-1', 'support', 'shared', 1),
			('mailbox-o', 'owner', 'domain-1', 'owner', 'personal', 5),
			('mailbox-n', 'owner', 'domain-1', 'owner2', 'personal', 9);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('access-owner', 'mailbox-s', 'owner', 'full_access', 1),
			('access-member', 'mailbox-s', 'member', 'read_only', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES
			('contact-1', 'owner', 'billing@streamflix.example', 'Streamflix Billing', 'inbound', 1);
	`);
	db.db
		.prepare(
			"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES ('wh-owner', 'owner', 'https://hooks.kite-validation.invalid/f', 'whsec_test', ?, 1, 3, 1)",
		)
		.run(JSON.stringify(["finance.subscription.detected"]));
	const objects = new Map();
	const bucket = {
		get: async (key) => {
			const value = objects.get(key);
			return value ? { arrayBuffer: async () => new TextEncoder().encode(value).buffer } : null;
		},
	};
	const env = { DB: db, BUCKET: bucket, OUTBOUND_QUEUE: { send: async () => undefined } };
	globalThis.__kiteNodeEnv = env;
	globalThis.fetch = async () => new Response("ok", { status: 200 });
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		globalThis.fetch = realFetch;
		clearModuleStateCache();
	});
	let order = 10;
	const addMessage = (
		id,
		{ subject = "Your Streamflix receipt", text, attachments = [], mailboxId = "mailbox-s" } = {},
	) => {
		order += 1;
		const body = text ?? `Thank you for your payment.\nPlan: Premium $17.99/month, renews on ${day(20)}.\n`;
		objects.set(`raw/${id}`, rawMime(subject, body));
		db.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, raw_r2_key, status, created_at) VALUES (?, 'boss', ?, 'inbound', ?, 'support@example.com', ?, ?, ?, 'received', ?)",
			)
			.run(id, mailboxId, SENDER, subject, body, `raw/${id}`, Math.floor(Date.now() / 1000) - 1000 + order);
		for (const attachment of attachments)
			db.db
				.prepare(
					"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, ?, 'application/pdf', 1200, ?, 1)",
				)
				.run(attachment, id, `${attachment}.pdf`, `att/${attachment}`);
	};
	const rows = () => db.db.prepare("SELECT * FROM finance_subscriptions ORDER BY created_at").all();
	const documents = () => db.db.prepare("SELECT * FROM finance_charges ORDER BY created_at, rowid").all();
	const actions = () => db.db.prepare("SELECT * FROM agent_actions ORDER BY created_at, rowid").all();
	const action = (id) => db.db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(id);
	return { db, env, addMessage, rows, documents, actions, action };
}

const byHand = (overrides = {}) => ({
	vendor: "Gym Plus",
	plan: "Gold",
	amountMinor: 2500,
	currency: "EUR",
	cycle: "monthly",
	nextRenewalOn: day(10),
	reminderDays: 7,
	calendarReminder: false,
	mailboxId: "mailbox-o",
	...overrides,
});

const documentBody = (overrides = {}) => ({
	messageId: "pay-1",
	docType: "payment",
	amountMinor: 1799,
	currency: "USD",
	documentOn: day(0),
	...overrides,
});

test("a subscription added by hand is one audited create_subscription that undo removes", async (t) => {
	const { env, rows, action, db } = await setup(t);
	const added = await addSubscription(owner, byHand());
	assert.equal(added.status, 200, JSON.stringify(added.body));
	const { subscription, actionId } = added.body;
	assert.match(actionId, /^aact_/);
	assert.equal(subscription.id, `fsub_${actionId.replace(/^aact_/, "")}`);
	assert.deepEqual(
		[subscription.vendor, subscription.vendorKey, subscription.plan, subscription.amount, subscription.cycle],
		["Gym Plus", "manual:gym-plus", "Gold", { minor: 2500, currency: "EUR" }, "monthly"],
	);
	assert.deepEqual(
		[subscription.reminderDays, subscription.calendarReminder, subscription.mailboxId, subscription.cancelUrl],
		[7, false, "mailbox-o", null],
	);
	const audit = action(actionId);
	assert.deepEqual(
		[audit.action, audit.variant, audit.mailbox_id, audit.status, audit.initiator],
		["create_subscription", "", "mailbox-o", "applied", "user"],
	);
	const delivery = db.db.prepare("SELECT payload FROM webhook_deliveries").get();
	assert.equal(JSON.parse(delivery.payload).data.source, "manual");
	assert.equal(JSON.parse(delivery.payload).data.message, null);
	const { actions } = await listAgentActivity(env, "mailbox-o", "owner");
	assert.equal(actions[0].id, actionId);

	await undoAgentAction(env, owner, actionId);
	assert.deepEqual(rows(), []);
});

test("rows added by hand store the chosen mailbox, default to the oldest managed one and need one", async (t) => {
	const { rows } = await setup(t);
	const chosen = await addSubscription(owner, byHand({ mailboxId: "mailbox-n" }));
	assert.equal(chosen.body.subscription.mailboxId, "mailbox-n");
	const fallback = await addSubscription(owner, byHand({ mailboxId: undefined }));
	assert.equal(fallback.body.subscription.mailboxId, "mailbox-s", "the oldest mailbox the owner manages");
	const foreign = await addSubscription(member, byHand({ mailboxId: "mailbox-s" }));
	assert.equal(foreign.status, 409, "read-only access manages no mailbox");
	assert.equal(foreign.body.code, "NO_MAILBOX");
	const none = await addSubscription(lonely, byHand({ mailboxId: undefined }));
	assert.deepEqual(none, {
		status: 409,
		body: { error: "Money Watch needs a mailbox you manage to record changes", code: "NO_MAILBOX" },
	});
	const notMine = await addSubscription(owner, byHand({ mailboxId: "mailbox-unknown" }));
	assert.equal(notMine.status, 404);
	assert.equal(rows().length, 2);
});

test("edits name the row's mailbox, else the oldest managed one, else answer NO_MAILBOX", async (t) => {
	const { db, action } = await setup(t);
	const added = await addSubscription(owner, byHand({ mailboxId: "mailbox-s" }));
	const id = added.body.subscription.id;

	const kept = await changeSubscription(owner, id, { reminderDays: 1 });
	assert.equal(kept.status, 200);
	assert.equal(action(kept.body.actionId).mailbox_id, "mailbox-s", "the row's mailbox while the owner manages it");

	db.db.exec("DELETE FROM mailbox_access WHERE id = 'access-owner'");
	const moved = await changeSubscription(owner, id, { reminderDays: 2 });
	assert.equal(moved.status, 200);
	assert.equal(action(moved.body.actionId).mailbox_id, "mailbox-o", "the owner's oldest managed mailbox");

	db.db.exec("UPDATE mailboxes SET disabled = 1 WHERE user_id = 'owner'");
	const none = await changeSubscription(owner, id, { reminderDays: 3 });
	assert.deepEqual(none, {
		status: 409,
		body: { error: "Money Watch needs a mailbox you manage to record changes", code: "NO_MAILBOX" },
	});
	const removed = await removeSubscription(owner, id);
	assert.equal(removed.body.code, "NO_MAILBOX");
});

test("edits, reminders, every status and removal are audited and undo restores the row", async (t) => {
	const { env, action, rows, documents, addMessage } = await setup(t);
	addMessage("pay-1");
	const id = (await addSubscription(owner, byHand())).body.subscription.id;
	const snapshot = () => {
		const { updated_at: _updated, ...rest } = rows()[0];
		return rest;
	};
	const before = snapshot();

	const edited = await changeSubscription(owner, id, { fields: { vendor: "Gym Max", amountMinor: 3000 } });
	assert.equal(edited.status, 200);
	assert.deepEqual([edited.body.subscription.vendor, edited.body.subscription.amount.minor], ["Gym Max", 3000]);
	assert.deepEqual(
		[action(edited.body.actionId).action, action(edited.body.actionId).variant],
		["update_subscription", ""],
	);
	await undoAgentAction(env, owner, edited.body.actionId);
	assert.deepEqual(snapshot(), before);

	const reminder = await changeSubscription(owner, id, { reminderDays: 14, calendarReminder: true });
	assert.equal(action(reminder.body.actionId).variant, "reminder");
	await undoAgentAction(env, owner, reminder.body.actionId);
	assert.deepEqual(snapshot(), before);

	for (const status of ["trial", "cancelled", "expired", "active"]) {
		const changed = await changeSubscription(owner, id, { status });
		assert.equal(changed.body.subscription.status, status);
		const audit = action(changed.body.actionId);
		assert.deepEqual([audit.action, audit.variant], ["set_subscription_status", status]);
		await undoAgentAction(env, owner, changed.body.actionId);
		assert.equal(rows()[0].status, "active");
	}

	const recorded = await addDocument(owner, id, documentBody());
	const removed = await removeSubscription(owner, id);
	assert.equal(removed.status, 200);
	assert.equal(action(removed.body.actionId).action, "delete_subscription");
	assert.deepEqual([rows(), documents()], [[], []]);
	await undoAgentAction(env, owner, removed.body.actionId);
	assert.deepEqual(snapshot(), before);
	assert.deepEqual(
		documents().map((document) => document.id),
		[recorded.body.document.id],
	);
});

test("documents from a message are recorded once, need the message's own attachment and undo", async (t) => {
	const { env, addMessage, documents, action, rows, db } = await setup(t);
	addMessage("pay-1", { attachments: ["att-1"] });
	addMessage("other", { attachments: ["att-2"] });
	const id = (await addSubscription(owner, byHand())).body.subscription.id;
	db.db.exec(`UPDATE finance_subscriptions SET payment_failed_at = 1000 WHERE id = '${id}'`);

	const foreign = await addDocument(owner, id, documentBody({ attachmentId: "att-2" }));
	assert.deepEqual([foreign.status, foreign.body.error], [404, "Attachment not found"]);
	const recorded = await addDocument(
		owner,
		id,
		documentBody({ attachmentId: "att-1", periodStartOn: day(-30), periodEndOn: day(0) }),
	);
	assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
	const { document, actionId } = recorded.body;
	assert.deepEqual(
		[document.docType, document.amount, document.messageId, document.attachmentId, document.periodStartOn],
		["payment", { minor: 1799, currency: "USD" }, "pay-1", "att-1", day(-30)],
	);
	const audit = action(actionId);
	assert.deepEqual(
		[audit.action, audit.variant, audit.mailbox_id, audit.message_id],
		["record_document", "payment", "mailbox-o", null],
		"the row's audit mailbox, without the receipt from another mailbox",
	);
	assert.equal(documents()[0].message_id, "pay-1", "the ledger row still links the receipt");
	assert.equal(rows()[0].payment_failed_at, null, "a payment clears the failed payment");

	const again = await addDocument(owner, id, documentBody({ attachmentId: "att-1" }));
	assert.deepEqual(again, {
		status: 409,
		body: { error: "This document is already recorded for the subscription", code: "DOCUMENT_EXISTS" },
	});
	assert.equal(documents().length, 1);
	const invoice = await addDocument(owner, id, documentBody({ docType: "invoice" }));
	assert.equal(invoice.status, 200, "another type from the same message is a separate document");

	await undoAgentAction(env, owner, actionId);
	assert.deepEqual(
		documents().map((row) => row.doc_type),
		["invoice"],
	);
	assert.ok(rows()[0].payment_failed_at, "undo restores the failed payment");

	const removed = await removeDocument(owner, invoice.body.document.id);
	assert.equal(removed.status, 200);
	assert.equal(action(removed.body.actionId).action, "delete_document");
	assert.deepEqual(documents(), []);
	await undoAgentAction(env, owner, removed.body.actionId);
	assert.deepEqual(
		documents().map((row) => row.id),
		[invoice.body.document.id],
		"undo puts the document back with its id",
	);
});

test("documents name the row's audit mailbox, are owner-only and answer NO_MAILBOX without one", async (t) => {
	const { db, addMessage, action, documents, actions } = await setup(t);
	addMessage("pay-1");
	addMessage("pay-o", { mailboxId: "mailbox-o" });
	const id = (await addSubscription(owner, byHand())).body.subscription.id;

	const same = await addDocument(owner, id, documentBody({ messageId: "pay-o" }));
	assert.equal(same.status, 200, JSON.stringify(same.body));
	assert.deepEqual(
		[action(same.body.actionId).mailbox_id, action(same.body.actionId).message_id],
		["mailbox-o", "pay-o"],
		"a receipt in the audit mailbox is named on the audit row",
	);

	const stranger = await addDocument(boss, id, documentBody({ docType: "invoice" }));
	assert.equal(stranger.status, 404, "anyone but the owner gets 404");

	db.db.exec("DELETE FROM mailbox_access WHERE id = 'access-owner'");
	db.db.exec("UPDATE mailboxes SET disabled = 1 WHERE user_id = 'owner'");
	const written = actions().length;
	const none = await addDocument(owner, id, documentBody({ docType: "invoice" }));
	assert.deepEqual(none, {
		status: 409,
		body: { error: "Money Watch needs a mailbox you manage to record changes", code: "NO_MAILBOX" },
	});
	assert.equal(actions().length, written);
	assert.equal(documents().length, 1);
});

test("rows and documents are owner-only and out-of-bounds input writes nothing", async (t) => {
	const { addMessage, rows, documents, actions } = await setup(t);
	addMessage("pay-1");
	const id = (await addSubscription(owner, byHand())).body.subscription.id;
	const docId = (await addDocument(owner, id, documentBody())).body.document.id;
	const written = actions().length;

	for (const answer of [
		await changeSubscription(boss, id, { status: "cancelled" }),
		await removeSubscription(boss, id),
		await addDocument(boss, id, documentBody({ docType: "invoice" })),
		await removeDocument(boss, docId),
		await changeSubscription(member, id, { reminderDays: 1 }),
	])
		assert.equal(answer.status, 404);

	for (const body of [
		byHand({ amountMinor: 0 }),
		byHand({ amountMinor: 100_000_001 }),
		byHand({ currency: "ABC" }),
		byHand({ currency: undefined }),
		byHand({ cycle: "fortnightly" }),
		byHand({ nextRenewalOn: day(800) }),
		byHand({ reminderDays: 31 }),
		byHand({ vendor: "v".repeat(81) }),
		byHand({ plan: "p".repeat(81) }),
		null,
	])
		assert.equal((await addSubscription(owner, body)).status, 400, JSON.stringify(body));
	for (const body of [{ reminderDays: 31 }, { fields: { amountMinor: -1 } }, { status: "paused" }, { fields: {} }])
		assert.equal((await changeSubscription(owner, id, body)).status, 400, JSON.stringify(body));
	for (const body of [
		documentBody({ documentOn: day(2) }),
		documentBody({ documentOn: day(-1900) }),
		documentBody({ periodStartOn: day(-400), periodEndOn: day(0) }),
		documentBody({ periodStartOn: day(0), periodEndOn: day(-1) }),
		documentBody({ amountMinor: undefined }),
	])
		assert.equal((await addDocument(owner, id, body)).status, 400, JSON.stringify(body));
	assert.equal(actions().length, written);
	assert.equal(rows().length, 1);
	assert.equal(documents().length, 1);
});

test("the detect draft prefills from the message, matches a tracked row and writes nothing", async (t) => {
	const { addMessage, rows, actions } = await setup(t);
	addMessage("inv-1", { subject: "Your Streamflix invoice", attachments: ["invoice-1"] });
	const draft = await detectDraft(owner, { messageId: "inv-1" });
	assert.equal(draft.status, 200, JSON.stringify(draft.body));
	assert.equal(draft.body.mailboxId, "mailbox-s");
	assert.deepEqual(draft.body.attachments, [
		{ id: "invoice-1", filename: "invoice-1.pdf", contentType: "application/pdf", size: 1200 },
	]);
	const fields = draft.body.draft;
	assert.deepEqual(
		[fields.vendor, fields.vendorKey, fields.plan, fields.amountMinor, fields.currency, fields.cycle],
		["Streamflix", "streamflix.example", "Premium", 1799, "USD", "monthly"],
	);
	assert.deepEqual(fields.cancelLink, { url: CANCEL, oneClick: true });
	assert.equal(fields.nextRenewalOn, day(20));
	assert.deepEqual([fields.document.docType, fields.document.attachmentId], ["invoice", "invoice-1"]);
	assert.equal(fields.subscriptionId, null);
	assert.deepEqual([rows(), actions()], [[], []]);

	const saved = await addSubscription(owner, {
		vendor: fields.vendor,
		plan: fields.plan,
		amountMinor: fields.amountMinor,
		currency: fields.currency,
		cycle: fields.cycle,
		nextRenewalOn: fields.nextRenewalOn,
		messageId: "inv-1",
		mailboxId: "mailbox-o",
		document: { ...fields.document, periodStartOn: null, periodEndOn: null },
	});
	assert.equal(saved.status, 200, JSON.stringify(saved.body));
	const [row] = rows();
	assert.deepEqual(
		[row.vendor_key, row.mailbox_id, row.source_message_id, row.contact_id, row.cancel_url, row.cancel_one_click],
		["streamflix.example", "mailbox-s", "inv-1", "contact-1", CANCEL, 1],
	);
	assert.equal(saved.body.documentRecorded, true);

	addMessage("inv-2", { subject: "Your Streamflix invoice", text: "Invoice\nPremium $17.99/month" });
	const matched = await detectDraft(owner, { messageId: "inv-2" });
	assert.equal(matched.body.draft.subscriptionId, row.id);

	assert.equal((await detectDraft(member, { messageId: "inv-1" })).status, 404, "read-only access is not enough");
	assert.equal((await detectDraft(lonely, { messageId: "inv-1" })).status, 404);
	assert.equal((await detectDraft(owner, { messageId: "missing" })).status, 404);
	assert.equal((await detectDraft(owner, {})).status, 400);
});

test("accepting a card for a document recorded by hand inserts no second ledger row", async (t) => {
	const { db, addMessage, documents } = await setup(t);
	addMessage("pay-1", { subject: "Your Streamflix receipt" });
	const id = (await addSubscription(owner, byHand({ vendor: "Streamflix" }))).body.subscription.id;
	db.db.exec(`UPDATE finance_subscriptions SET vendor_key = 'streamflix.example' WHERE id = '${id}'`);
	assert.equal((await addDocument(owner, id, documentBody())).status, 200);
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES ('sugg-1', 'mailbox-s', 'pay-1', 'owner', 'subscription', 'open', 'Update it?', ?, 1)",
		)
		.run(
			JSON.stringify({
				event: "renewal",
				subscriptionId: id,
				vendor: "Streamflix",
				vendorKey: "streamflix.example",
				plan: null,
				amountMinor: 1799,
				currency: "USD",
				previousAmountMinor: null,
				cycle: "monthly",
				nextRenewalOn: day(30),
				renewalEstimated: false,
				trialEndsOn: null,
				cancelLink: null,
				document: {
					docType: "payment",
					documentOn: day(0),
					periodStartOn: null,
					periodEndOn: null,
					attachmentId: null,
				},
				unverified: false,
				signals: ["cycle"],
				modelFields: [],
				modelDisagrees: [],
			}),
		);
	const accepted = await acceptSuggestion(globalThis.__kiteNodeEnv, owner, "sugg-1", "track", null);
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.documentRecorded, false);
	assert.equal(documents().length, 1);
});

test("Activity shows another full-access user only the ref of a removed and restored subscription", async (t) => {
	const { env, db, addMessage } = await setup(t);
	db.db.exec("UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'access-member'");
	addMessage("pay-1");
	const id = (await addSubscription(owner, byHand({ mailboxId: "mailbox-s" }))).body.subscription.id;
	await addDocument(owner, id, documentBody());
	const removed = await removeSubscription(owner, id);
	assert.equal(removed.status, 200);
	await undoAgentAction(env, owner, removed.body.actionId);

	const ref = { kind: "finance:subscription", id };
	const { actions } = await listAgentActivity(env, "mailbox-s", "member");
	const finance = actions.filter(
		(action) => action.action.endsWith("_subscription") || action.action.endsWith("_document"),
	);
	assert.ok(finance.length >= 3);
	for (const action of finance) assert.deepEqual(action.after, { ref }, `${action.action} ${action.variant}`);
	assert.ok(finance.some((action) => action.undoOf === removed.body.actionId));
	const text = JSON.stringify(actions);
	for (const secret of ["Gym Plus", "Gold", "2500", "removed", "documents", "vendor"])
		assert.equal(text.includes(secret), false, secret);
	for (const action of finance) assert.deepEqual(action.target, { href: null, label: "Subscription" });

	const own = await listAgentActivity(env, "mailbox-s", "owner");
	const undo = own.actions.find((action) => action.undoOf === removed.body.actionId);
	assert.deepEqual(undo.after, { ref });
	assert.equal(undo.target.href, `/finance?subscription=${id}`);
	const stored = db.db
		.prepare("SELECT after FROM agent_actions WHERE variant = ?")
		.get(`undo:${removed.body.actionId}`);
	assert.ok(JSON.parse(stored.after).removed, "the stored inverse keeps its snapshot");
});
