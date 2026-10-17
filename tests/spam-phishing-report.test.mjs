import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-spam-phishing-report-");
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
		text: fileURLToPath(import.meta.resolve("../src/components/messages/phishing-report-utils.ts")),
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
const { reportPhishingAll } = await load("report");
const { applySpamFeedback } = await load("feedback");
const { classifyTokens } = await load("classifier");
const { getDb } = await load("db");
const { getStatusForBulkAction, isAllowedBulkMessageAction } = await load("bulk");
const { POST: bulkMessages } = await load("bulkRoute");
const { createSession } = await load("session");
const { describePhishingReports, phishingConfirmCopy } = await load("text");
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

const reputation = (db, type) =>
	db.db.prepare("SELECT spam_count, ham_count FROM spam_reputation WHERE type = ? ORDER BY key").all(type);

test("a phishing report trains like spam, with three times the weight on the fingerprint only", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const id = addMessage("billing@invoices-portal.test");
	assert.equal(await applySpamFeedback(env, owner, id, "phishing"), true);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status, "spam");
	assert.equal(db.db.prepare("SELECT classification FROM spam_feedback").get().classification, "phishing");
	assert.deepEqual(reputation(db, "fingerprint"), [{ spam_count: 3, ham_count: 0 }]);
	for (const type of ["email", "domain"]) assert.deepEqual(reputation(db, type), [{ spam_count: 1, ham_count: 0 }]);
	const tokens = db.db.prepare("SELECT DISTINCT spam_count, ham_count FROM spam_token_stats").all();
	assert.deepEqual(tokens, [{ spam_count: 1, ham_count: 0 }]);

	// "Not spam" afterwards takes back exactly what the report added.
	assert.equal(await applySpamFeedback(env, owner, id, "ham"), true);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status, "received");
	assert.deepEqual(reputation(db, "fingerprint"), [{ spam_count: 0, ham_count: 1 }]);
	for (const type of ["email", "domain"]) assert.deepEqual(reputation(db, type), [{ spam_count: 0, ham_count: 1 }]);
});

test("the classifier counts phishing reports as spam reports", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const tokensOf = () =>
		db.db
			.prepare("SELECT token FROM spam_token_stats")
			.all()
			.map((row) => row.token);
	for (let index = 0; index < 3; index += 1)
		await applySpamFeedback(env, owner, addMessage(`billing${index}@invoices-portal.test`), "phishing");
	await applySpamFeedback(env, owner, addMessage("colleague@partner.test", { subject: "Lunch on Friday" }), "ham");
	const asPhishing = await classifyTokens(getDb(env), "mailbox-a", tokensOf());
	assert.equal(asPhishing.trainedMessages, 4);
	db.db.exec("UPDATE spam_feedback SET classification = 'spam' WHERE classification = 'phishing'");
	const asSpam = await classifyTokens(getDb(env), "mailbox-a", tokensOf());
	assert.deepEqual(asPhishing, asSpam);
});

test("Report phishing blocks an unknown sender, keeps contacts and own domains, and closes the warning", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const stranger = addMessage("Billing <Billing@Invoices-Portal.test>");
	const contact = addMessage("friend@partner.test");
	const ownDomain = addMessage("ceo@example.com");
	const outbound = addMessage("a@example.com", { direction: "outbound" });
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, created_at) VALUES ('sugg-1', 'mailbox-a', ?, 'owner', 'phishing', 'open', 'This may be phishing', 1)",
		)
		.run(stranger);

	const reports = await reportPhishingAll(env, owner, [stranger, contact, ownDomain, outbound, stranger]);
	assert.deepEqual(reports, [
		{ messageId: stranger, blockedSender: "billing@invoices-portal.test", notBlocked: null },
		{ messageId: contact, blockedSender: null, notBlocked: "trusted_contact" },
		{ messageId: ownDomain, blockedSender: null, notBlocked: "own_domain" },
	]);
	const blocked = db.db.prepare("SELECT email FROM contacts WHERE blocked = 1").all();
	assert.deepEqual(blocked, [{ email: "billing@invoices-portal.test" }]);
	const rules = db.db.prepare("SELECT match_value, action FROM routing_rules").all();
	assert.deepEqual(rules, [{ match_value: "billing@invoices-portal.test", action: "trash" }]);
	const statuses = db.db.prepare("SELECT id, status FROM messages ORDER BY id").all();
	assert.deepEqual(
		statuses.map((row) => row.status),
		["spam", "spam", "spam", "received"],
	);
	const suggestion = db.db.prepare("SELECT status, decided_by_user_id FROM agent_suggestions").get();
	assert.deepEqual({ ...suggestion }, { status: "accepted", decided_by_user_id: "owner" });
	const audits = db.db.prepare("SELECT action FROM audit_logs WHERE action = 'email.phishing_report'").all();
	assert.equal(audits.length, 3);
});

test("a user without full access to the mailbox reports nothing", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const id = addMessage("billing@invoices-portal.test");
	const outsider = { id: "outsider", role: "user", isPrimaryAdmin: false, email: "outsider@example.com" };
	assert.deepEqual(await reportPhishingAll(env, outsider, [id]), []);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status, "received");
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE blocked = 1").get().n, 0);
});

test("the bulk endpoint accepts phishing and moves the selection to Spam", () => {
	assert.equal(isAllowedBulkMessageAction("phishing"), true);
	assert.equal(getStatusForBulkAction("phishing"), "spam");
});

test("Move to Inbox clears snoozes on spam and normal messages while recording ham feedback", async (t) => {
	const { db, env, addMessage } = await setup(t);
	const spam = addMessage("billing@invoices-portal.test");
	const normal = addMessage("friend@partner.test");
	db.db.prepare("UPDATE messages SET snoozed_until = ?").run(Math.floor(Date.now() / 1000) + 86_400);
	await applySpamFeedback(env, owner, spam, "spam");
	const token = await createSession(env, owner.id);
	const response = await bulkMessages(
		new Request("https://kite.test/api/messages/bulk", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ action: "inbox", messageIds: [spam, normal] }),
		}),
	);
	assert.equal(response.status, 200);
	for (const id of [spam, normal]) {
		const message = db.db.prepare("SELECT status, folder_id, snoozed_until FROM messages WHERE id = ?").get(id);
		assert.deepEqual({ ...message }, { status: "received", folder_id: null, snoozed_until: null });
	}
	assert.equal(
		db.db.prepare("SELECT classification FROM spam_feedback WHERE message_id = ?").get(spam).classification,
		"ham",
	);
	assert.deepEqual(reputation(db, "fingerprint"), [{ spam_count: 0, ham_count: 1 }]);
});

test("the confirmation and the toast say what happened to each sender", () => {
	assert.equal(phishingConfirmCopy(1).title, "Report this message as phishing?");
	assert.match(phishingConfirmCopy(3).description, /blocks the senders/);
	assert.equal(describePhishingReports([]), null);
	assert.equal(
		describePhishingReports([{ messageId: "m1", blockedSender: "x@bad.test", notBlocked: null }]),
		"Reported as phishing. Mail from x@bad.test now goes to Trash.",
	);
	assert.match(
		describePhishingReports([{ messageId: "m1", blockedSender: null, notBlocked: "own_domain" }]),
		/not blocked because it uses one of your own domains/,
	);
	assert.equal(
		describePhishingReports([
			{ messageId: "m1", blockedSender: "x@bad.test", notBlocked: null },
			{ messageId: "m2", blockedSender: "x@bad.test", notBlocked: null },
			{ messageId: "m3", blockedSender: null, notBlocked: "trusted_contact" },
		]),
		"3 messages reported as phishing. 1 sender is now blocked.",
	);
});
