import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-spam-report-undo-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		report: fileURLToPath(import.meta.resolve("../src/lib/spam/phishing-report.ts")),
		feedback: fileURLToPath(import.meta.resolve("../src/lib/spam/feedback.ts")),
		classifier: fileURLToPath(import.meta.resolve("../src/lib/spam/classifier.ts")),
		db: fileURLToPath(import.meta.resolve("../src/db/index.ts")),
		bulk: fileURLToPath(import.meta.resolve("../src/app/api/messages/bulk/utils.ts")),
		bulkRoute: fileURLToPath(import.meta.resolve("../src/app/api/messages/bulk/route.ts")),
		session: fileURLToPath(import.meta.resolve("../src/lib/auth/session.ts")),
		receipts: fileURLToPath(import.meta.resolve("../src/lib/spam/report-receipts.ts")),
		user: fileURLToPath(import.meta.resolve("../src/lib/user.ts")),
		contacts: fileURLToPath(import.meta.resolve("../src/lib/contacts/service.ts")),
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
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { reportPhishingWithUndo } = await load("report");
const { applySpamFeedback, applySpamFeedbackWithReceipt } = await load("feedback");
const { POST: bulkMessages } = await load("bulkRoute");
const { createSession } = await load("session");
const { undoSpamReceipt, undoLatestSpamReceipt } = await load("receipts");
const { updateMessageStatusForUser } = await load("user");
const { blockContact } = await load("contacts");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const owner = { id: "owner", role: "user", isPrimaryAdmin: false, email: "owner@example.com" };
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
// Blocking a new contact looks up a Gravatar; nothing leaves the test.
globalThis.fetch = async () => new Response("", { status: 404 });

let count = 0;
async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at, last_seen_at) VALUES ('contact-1', 'owner', 'friend@partner.test', 'Friend', 'manual', 1, 1);
	`);
	const env = { DB: db };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const addMessage = (fromAddr, { direction = "inbound", subject = "Invoice 4471 attached" } = {}) => {
		const id = `msg-${++count}`;
		db.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', 'mailbox-a', ?, ?, 'a@example.com', ?, 'Please add us to your whitelist so our invoices reach you.', 'received', 1)",
			)
			.run(id, direction, fromAddr, subject);
		return id;
	};
	return { db, env, addMessage };
}

/** Everything the classifier reads, so "identical" means every count of every row. */
function classifierState(db) {
	const rows = (sql) =>
		db.db
			.prepare(sql)
			.all()
			.map((row) => ({ ...row }));
	return {
		tokens: rows("SELECT mailbox_id, token, spam_count, ham_count FROM spam_token_stats ORDER BY mailbox_id, token"),
		reputation: rows(
			"SELECT mailbox_id, type, key, messages_seen, spam_count, ham_count FROM spam_reputation ORDER BY mailbox_id, type, key",
		),
		feedback: rows(
			"SELECT message_id, classification, actor_user_id, training_tokens, reputation_keys FROM spam_feedback ORDER BY message_id",
		),
	};
}

const place = (db, id) => ({ ...db.db.prepare("SELECT status, folder_id FROM messages WHERE id = ?").get(id) });

async function bulk(env, body) {
	const token = await createSession(env, owner.id);
	const response = await bulkMessages(
		new Request("https://kite.test/api/messages/bulk", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return { status: response.status, json: await response.json() };
}

test("a spam report followed by Undo leaves every classifier count as it was", async (t) => {
	const { db, env, addMessage } = await setup(t);
	// Other mail already trained the filter, so some of the report's rows exist and some are new.
	await applySpamFeedback(env, owner, addMessage("deals@promo.test", { subject: "Invoice 4471 attached" }), "spam");
	await applySpamFeedback(env, owner, addMessage("friend@partner.test", { subject: "Lunch on Friday" }), "ham");
	const target = addMessage("billing@invoices-portal.test", { subject: "Invoice 8812 attached" });
	db.db
		.prepare(
			"INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'owner', 'mailbox-a', 'Bills', 1)",
		)
		.run();
	db.db.prepare("UPDATE messages SET folder_id = 'folder-1' WHERE id = ?").run(target);
	const before = classifierState(db);

	const result = await applySpamFeedbackWithReceipt(env, owner, target, "spam");
	assert.ok(result.receiptId);
	assert.deepEqual(place(db, target), { status: "spam", folder_id: null });
	assert.notDeepEqual(classifierState(db), before);

	assert.equal(await undoSpamReceipt(env, target, result.receiptId), "undone");
	assert.deepEqual(classifierState(db), before);
	assert.deepEqual(place(db, target), { status: "received", folder_id: "folder-1" });
});

test("Undo on a message nothing else was trained on removes the rows the report created", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	const before = classifierState(db);
	assert.deepEqual(before, { tokens: [], reputation: [], feedback: [] });
	const result = await applySpamFeedbackWithReceipt(env, owner, target, "phishing");
	assert.ok(db.db.prepare("SELECT COUNT(*) AS n FROM spam_token_stats").get().n > 0);
	assert.equal(await undoSpamReceipt(env, target, result.receiptId), "undone");
	assert.deepEqual(classifierState(db), before);
});

test("Undo restores an earlier Not spam, including its counts, after a report flipped it", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	await applySpamFeedback(env, owner, target, "spam");
	await applySpamFeedback(env, owner, target, "ham");
	const before = classifierState(db);
	assert.equal(before.feedback[0].classification, "ham");

	const result = await applySpamFeedbackWithReceipt(env, owner, target, "phishing");
	assert.equal(db.db.prepare("SELECT classification FROM spam_feedback").get().classification, "phishing");
	assert.equal(await undoSpamReceipt(env, target, result.receiptId), "undone");
	assert.deepEqual(classifierState(db), before);
});

test("a phishing report's Undo restores the three-times fingerprint weight exactly", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const first = addMessage("billing@invoices-portal.test");
	const second = addMessage("billing@invoices-portal.test");
	await applySpamFeedback(env, owner, first, "phishing");
	const before = classifierState(db);
	const result = await applySpamFeedbackWithReceipt(env, owner, second, "phishing");
	const fingerprint = db.db.prepare("SELECT spam_count FROM spam_reputation WHERE type = 'fingerprint'").get();
	assert.equal(fingerprint.spam_count, 6);
	await undoSpamReceipt(env, second, result.receiptId);
	assert.deepEqual(classifierState(db), before);
	assert.equal(db.db.prepare("SELECT spam_count FROM spam_reputation WHERE type = 'fingerprint'").get().spam_count, 3);
});

test("undoing twice changes nothing the second time, even after more training", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	const result = await applySpamFeedbackWithReceipt(env, owner, target, "spam");
	assert.equal(await undoSpamReceipt(env, target, result.receiptId), "undone");
	await applySpamFeedback(env, owner, addMessage("deals@promo.test", { subject: "Invoice 4471 attached" }), "spam");
	const after = classifierState(db);
	assert.equal(await undoSpamReceipt(env, target, result.receiptId), "already_undone");
	assert.deepEqual(classifierState(db), after);
	// Counts never go below zero, whatever happens.
	assert.equal(
		db.db.prepare("SELECT COUNT(*) AS n FROM spam_token_stats WHERE spam_count < 0 OR ham_count < 0").get().n,
		0,
	);
});

test("an Undo for a report that a later Not spam replaced leaves the newer training alone", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	const result = await applySpamFeedbackWithReceipt(env, owner, target, "spam");
	await applySpamFeedback(env, owner, target, "ham");
	const after = classifierState(db);
	await undoSpamReceipt(env, target, result.receiptId);
	assert.deepEqual(classifierState(db), after);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(target).status, "received");
});

test("an Undo does not move a message that was moved again since", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	const result = await applySpamFeedbackWithReceipt(env, owner, target, "spam");
	db.db.prepare("UPDATE messages SET status = 'trash' WHERE id = ?").run(target);
	await undoSpamReceipt(env, target, result.receiptId);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(target).status, "trash");
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM spam_feedback").get().n, 0);
});

test("a phishing report's Undo lifts the block it placed and reopens the warning it closed", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("Billing <billing@invoices-portal.test>");
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, created_at) VALUES ('sugg-1', 'mailbox-a', ?, 'owner', 'phishing', 'open', 'This may be phishing', 1)",
		)
		.run(target);
	const before = classifierState(db);
	const [outcome] = await reportPhishingWithUndo(env, owner, [target]);
	assert.equal(outcome.report.blockedSender, "billing@invoices-portal.test");
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM routing_rules").get().n, 1);
	assert.equal(db.db.prepare("SELECT status FROM agent_suggestions").get().status, "accepted");

	assert.equal(await undoSpamReceipt(env, target, outcome.undo.receiptId), "undone");
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM routing_rules").get().n, 0);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked = 1").get().n, 0);
	assert.deepEqual(
		{ ...db.db.prepare("SELECT status, decided_by_user_id FROM agent_suggestions").get() },
		{ status: "open", decided_by_user_id: null },
	);
	assert.deepEqual(classifierState(db), before);
	assert.deepEqual(place(db, target), { status: "received", folder_id: null });
});

test("a block the user set before the report survives its Undo", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("Billing <billing@invoices-portal.test>");
	await blockContact(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		domainId: "domain-1",
		address: "billing@invoices-portal.test",
	});
	const [outcome] = await reportPhishingWithUndo(env, owner, [target]);
	assert.equal(outcome.report.blockedSender, "billing@invoices-portal.test");
	await undoSpamReceipt(env, target, outcome.undo.receiptId);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM routing_rules").get().n, 1);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked = 1").get().n, 1);
});

test("a sender kept because of a saved contact is never unblocked or blocked by an Undo", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("friend@partner.test");
	const [outcome] = await reportPhishingWithUndo(env, owner, [target]);
	assert.equal(outcome.report.notBlocked, "trusted_contact");
	await undoSpamReceipt(env, target, outcome.undo.receiptId);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM routing_rules").get().n, 0);
	assert.equal(db.db.prepare("SELECT blocked FROM contacts WHERE email = 'friend@partner.test'").get().blocked, 0);
});

test("the bulk endpoint returns receipts for spam and phishing, and restore uses them", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const first = addMessage("billing@invoices-portal.test");
	const second = addMessage("deals@promo.test", { subject: "Invoice 4471 attached" });
	const before = classifierState(db);
	const spam = await bulk(env, { action: "spam", messageIds: [first, second] });
	assert.equal(spam.status, 200);
	assert.equal(spam.json.undo.length, 2);
	assert.ok(spam.json.undo.every((state) => state.status === "received" && state.receiptId));
	assert.equal(spam.json.trainingUndoUnavailable, undefined);

	const restored = await bulk(env, { action: "restore", restore: spam.json.undo });
	assert.equal(restored.status, 200);
	assert.deepEqual(classifierState(db), before);
	assert.equal(place(db, first).status, "received");
	// The same Undo again is harmless.
	assert.equal((await bulk(env, { action: "restore", restore: spam.json.undo })).status, 200);
	assert.deepEqual(classifierState(db), before);

	const phishing = await bulk(env, { action: "phishing", messageIds: [first] });
	assert.equal(phishing.json.reports.length, 1);
	assert.ok(phishing.json.undo[0].receiptId);
	await bulk(env, { action: "restore", restore: phishing.json.undo });
	assert.deepEqual(classifierState(db), before);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked = 1").get().n, 0);
});

test("before the migration a report still works and Undo only puts the place back", async (t) => {
	const { db, env, addMessage } = await setup(t);
	db.db.exec("DROP TABLE spam_report_receipts");
	const target = addMessage("billing@invoices-portal.test");
	const spam = await bulk(env, { action: "spam", messageIds: [target] });
	assert.equal(spam.status, 200);
	assert.equal(spam.json.trainingUndoUnavailable, true);
	assert.equal(spam.json.undo[0].receiptId, null);
	assert.equal(place(db, target).status, "spam");
	await bulk(env, { action: "restore", restore: spam.json.undo });
	assert.deepEqual(place(db, target), { status: "received", folder_id: null });
	// What the filter learned stays, which is why the client says so.
	assert.equal(db.db.prepare("SELECT classification FROM spam_feedback").get().classification, "spam");
});

test("a move to Spam approved elsewhere untrains through the newest receipt since it started", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	const before = classifierState(db);
	const startedAt = new Date(Date.now() - 1000);
	assert.equal(await updateMessageStatusForUser(env, owner, target, "spam"), true);
	assert.equal(await undoLatestSpamReceipt(env, target, "to_spam", startedAt), "undone");
	assert.deepEqual(classifierState(db), before);
	assert.equal(await undoLatestSpamReceipt(env, target, "to_spam", startedAt), "missing");
});

test("Not spam through a receipt can be undone too", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const target = addMessage("billing@invoices-portal.test");
	await applySpamFeedback(env, owner, target, "spam");
	const before = classifierState(db);
	const startedAt = new Date(Date.now() - 1000);
	assert.equal(await updateMessageStatusForUser(env, owner, target, "received"), true);
	assert.equal(await undoLatestSpamReceipt(env, target, "from_spam", startedAt), "undone");
	assert.deepEqual(classifierState(db), before);
});
