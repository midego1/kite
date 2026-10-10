import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-suggestion-lifecycle-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		lifecycle: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/suggestion-lifecycle.ts")),
		api: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/suggestion-api.ts")),
		execute: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/execute.ts")),
		maintenance: fileURLToPath(import.meta.resolve("../src/lib/agent/maintenance.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { expireOpenSuggestions, settleTriageSuggestions, supersedeAfterSentReply } = await load("lifecycle");
const { listSuggestions, acceptSuggestion, dismissSuggestion } = await load("api");
const { undoAgentAction } = await load("execute");
const { runAgentMaintenance } = await load("maintenance");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY = 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const user = (id) => ({
	id,
	email: `${id}@example.com`,
	name: id,
	role: "user",
	isPrimaryAdmin: false,
	disabled: false,
});
const owner = user("owner");
const manager = user("manager");
const reader = user("reader");
const helper = user("helper");
const stranger = user("stranger");

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const now = nowSeconds();
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('manager', 'manager@example.com', 'hash', 'Manager', 1),
			('reader', 'reader@example.com', 'hash', 'Reader', 1),
			('helper', 'helper@example.com', 'hash', 'Helper', 1),
			('stranger', 'stranger@example.com', 'hash', 'Stranger', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'support', 'shared', 1),
			('mailbox-b', 'owner', 'domain-1', 'owner', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('access-1', 'mailbox-a', 'manager', 'full_access', 1),
			('access-2', 'mailbox-a', 'reader', 'read_only', 1),
			('access-3', 'mailbox-a', 'helper', 'send_on_behalf', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, autonomy, capabilities, updated_at) VALUES
			('mailbox-a', 'suggest', '{"calendar":false,"reply":true,"summary":true,"phishing":true,"mutedSenders":["old@sender.test"]}', 1),
			('mailbox-b', 'off', '{"calendar":true,"reply":true,"summary":true,"phishing":true}', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES
			('msg-a', 'owner', 'mailbox-a', 'inbound', 'Sam <Sam@Sender.test>', 'support@example.com', 'Question A', 'received', 'thread-1', ${now - 60}),
			('msg-p', 'owner', 'mailbox-a', 'inbound', 'Bank <alerts@bank.test>', 'support@example.com', 'Verify', 'received', 'thread-2', ${now - 50}),
			('msg-c', 'owner', 'mailbox-b', 'inbound', 'Cleo <cleo@sender.test>', 'owner@example.com', 'Hello', 'received', 'thread-3', ${now - 40}),
			('draft-a', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'sam@sender.test', 'Re: Question A', 'draft', 'thread-1', ${now - 30});
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, thread_id, reviewer_user_id, kind, status, title, payload, draft_id, created_at) VALUES
			('sugg-reply', 'mailbox-a', 'msg-a', 'thread-1', 'owner', 'reply', 'open', 'Reply to Sam', '{"urgency":"low"}', 'draft-a', ${now - 60}),
			('sugg-summary', 'mailbox-a', 'msg-a', 'thread-1', 'owner', 'summary', 'open', 'Summary', '{"text":"Short"}', NULL, ${now - 60}),
			('sugg-phish', 'mailbox-a', 'msg-p', 'thread-2', 'owner', 'phishing', 'open', 'Possible phishing', '{"reasons":["displayed_link_mismatch"]}', NULL, ${now - 50}),
			('sugg-other', 'mailbox-b', 'msg-c', 'thread-3', 'owner', 'reply', 'open', 'Reply to Cleo', '{}', NULL, ${now - 40});
	`);
	const notifications = [];
	const env = {
		DB: db,
		BUCKET: { delete: async () => {} },
		REALTIME: {
			getByName: (userId) => ({
				fetch: async (_url, init) => {
					notifications.push({ userId, payload: JSON.parse(init.body) });
					return new Response(null, { status: 204 });
				},
			}),
		},
	};
	return { db, env, notifications };
}

const statusOf = (db, id) => db.db.prepare("SELECT status FROM agent_suggestions WHERE id = ?").get(id).status;
const actionRows = (db) => db.db.prepare("SELECT * FROM agent_actions ORDER BY rowid").all();
const mutedSenders = (db) =>
	JSON.parse(
		db.db.prepare("SELECT capabilities FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-a'").get().capabilities,
	).mutedSenders;

function insertMessage(db, values) {
	const row = {
		user_id: "owner",
		mailbox_id: "mailbox-a",
		from_addr: "Sam <sam@sender.test>",
		to_addr: "support@example.com",
		subject: "Re: Question A",
		thread_id: "thread-1",
		created_at: nowSeconds(),
		...values,
	};
	const columns = Object.keys(row);
	db.db
		.prepare(`INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.run(...Object.values(row));
}

test("open suggestions expire after 14 days; younger and decided ones are untouched", async (t) => {
	const { db, env } = await setup(t);
	const now = nowSeconds();
	db.db.exec(`
		UPDATE agent_suggestions SET created_at = ${now - 15 * DAY} WHERE id = 'sugg-reply';
		UPDATE agent_suggestions SET created_at = ${now - 13 * DAY} WHERE id = 'sugg-summary';
		UPDATE agent_suggestions SET created_at = ${now - 20 * DAY}, status = 'dismissed' WHERE id = 'sugg-phish';
	`);
	assert.deepEqual(await expireOpenSuggestions(env), ["sugg-reply"]);
	assert.equal(statusOf(db, "sugg-reply"), "expired");
	assert.equal(statusOf(db, "sugg-summary"), "open");
	assert.equal(statusOf(db, "sugg-phish"), "dismissed");
	assert.equal(statusOf(db, "sugg-other"), "open");
});

test("runAgentMaintenance expires 15-day-old open suggestions", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`UPDATE agent_suggestions SET created_at = ${nowSeconds() - 15 * DAY} WHERE id = 'sugg-other'`);
	await runAgentMaintenance({ ...env, AGENT_QUEUE: { send: async () => {} } });
	assert.equal(statusOf(db, "sugg-other"), "expired");
	assert.equal(statusOf(db, "sugg-reply"), "open");
});

test("a newer inbound message in the thread supersedes only older open reply suggestions", async (t) => {
	const { db, env, notifications } = await setup(t);
	insertMessage(db, { id: "msg-b", direction: "inbound", status: "received" });
	await settleTriageSuggestions(env, "mailbox-a", { id: "msg-b", threadId: "thread-1" });
	assert.equal(statusOf(db, "sugg-reply"), "superseded");
	assert.equal(statusOf(db, "sugg-summary"), "open");
	assert.equal(statusOf(db, "sugg-phish"), "open");
	const ids = notifications.map((item) => item.payload.suggestionId);
	assert.deepEqual([...new Set(ids)], ["sugg-reply"]);
});

test("a draft does not supersede, a sent reply does, and only in its own mailbox and thread", async (t) => {
	const { db, env, notifications } = await setup(t);
	await supersedeAfterSentReply(env, "draft-a");
	assert.equal(statusOf(db, "sugg-reply"), "open");
	insertMessage(db, { id: "sent-a", direction: "outbound", status: "sent", from_addr: "support@example.com" });
	await supersedeAfterSentReply(env, "sent-a");
	assert.equal(statusOf(db, "sugg-reply"), "superseded");
	assert.equal(statusOf(db, "sugg-other"), "open");
	assert.ok(notifications.some((item) => item.payload.suggestionId === "sugg-reply"));
});

test("a message stored in the same second as the suggestion's message supersedes only when it came later", async (t) => {
	const { db, env } = await setup(t);
	const created = db.db.prepare("SELECT created_at FROM messages WHERE id = 'msg-a'").get().created_at;
	insertMessage(db, { id: "msg-same", direction: "inbound", status: "received", created_at: created });
	await settleTriageSuggestions(env, "mailbox-a", { id: "msg-same", threadId: "thread-1" });
	assert.equal(statusOf(db, "sugg-reply"), "superseded");
});

test("agent_suggestion events reach the owner and full-access sharers only", async (t) => {
	const { env, notifications } = await setup(t);
	await settleTriageSuggestions(env, "mailbox-a", { id: "msg-p", threadId: "thread-2" });
	assert.deepEqual(notifications.map((item) => item.userId).sort(), ["manager", "owner"]);
	assert.deepEqual(notifications[0].payload, {
		type: "agent_suggestion",
		mailboxId: "mailbox-a",
		messageId: "msg-p",
		suggestionId: "sugg-phish",
		kind: "phishing",
	});
});

test("the list is for full-access users; without a mailbox it spans their full-access mailboxes", async (t) => {
	const { env } = await setup(t);
	for (const viewer of [reader, helper, stranger])
		assert.equal(await listSuggestions(env, viewer, { mailboxId: "mailbox-a", status: "all" }), null);
	const forManager = await listSuggestions(env, manager, { mailboxId: null, status: "open" });
	assert.deepEqual(
		forManager.suggestions.map((item) => item.id),
		["sugg-phish", "sugg-summary", "sugg-reply"],
	);
	assert.deepEqual(forManager.mailboxes, [{ id: "mailbox-a", address: "support@example.com", autonomy: "suggest" }]);
	assert.deepEqual(forManager.suggestions[0].payload, { reasons: ["displayed_link_mismatch"] });
	assert.deepEqual(forManager.suggestions[0].message, { subject: "Verify", from: "Bank <alerts@bank.test>" });
	for (const viewer of [reader, helper, stranger])
		assert.deepEqual((await listSuggestions(env, viewer, { mailboxId: null, status: "open" })).suggestions, []);
	const forOwner = await listSuggestions(env, owner, { mailboxId: null, status: "open" });
	assert.equal(forOwner.suggestions.length, 4);
	assert.deepEqual(forOwner.mailboxes.map((item) => [item.id, item.autonomy]).sort(), [
		["mailbox-a", "suggest"],
		["mailbox-b", "off"],
	]);
	const byMessage = await listSuggestions(env, owner, { mailboxId: "mailbox-a", status: "all", messageId: "msg-a" });
	assert.deepEqual(byMessage.suggestions.map((item) => item.kind).sort(), ["reply", "summary"]);
	const dismissedOnly = await listSuggestions(env, owner, { mailboxId: "mailbox-a", status: "dismissed" });
	assert.deepEqual(dismissedOnly.suggestions, []);
});

test("users without full access get 404 from accept and dismiss, and nothing changes", async (t) => {
	const { db, env } = await setup(t);
	for (const viewer of [reader, helper, stranger]) {
		await assert.rejects(acceptSuggestion(env, viewer, "sugg-phish", "mark_spam"), { status: 404 });
		await assert.rejects(acceptSuggestion(env, viewer, "sugg-reply", ""), { status: 404 });
		await assert.rejects(dismissSuggestion(env, viewer, "sugg-reply", { muteSender: true }), { status: 404 });
		await assert.rejects(dismissSuggestion(env, viewer, "sugg-reply", null), { status: 404 });
	}
	await assert.rejects(dismissSuggestion(env, owner, "missing", {}), { status: 404 });
	assert.equal(statusOf(db, "sugg-reply"), "open");
	assert.equal(statusOf(db, "sugg-phish"), "open");
	assert.deepEqual(actionRows(db), []);
	assert.deepEqual(mutedSenders(db), ["old@sender.test"]);
});

test("accepting a reply returns its draft URL and leaves the suggestion open", async (t) => {
	const { db, env } = await setup(t);
	assert.deepEqual(await acceptSuggestion(env, manager, "sugg-reply", "review"), {
		status: "open",
		draftId: "draft-a",
		url: "/drafts/draft-a",
	});
	await assert.rejects(acceptSuggestion(env, manager, "sugg-reply", "mark_spam"), { status: 400 });
	await assert.rejects(acceptSuggestion(env, manager, "sugg-summary", "review"), { status: 400 });
	db.db.exec("UPDATE agent_suggestions SET draft_id = NULL WHERE id = 'sugg-reply'");
	await assert.rejects(acceptSuggestion(env, manager, "sugg-reply", "review"), { status: 409 });
	assert.equal(statusOf(db, "sugg-reply"), "open");
});

test("mark_spam moves the message, closes the warning as accepted, applies once and can be undone", async (t) => {
	const { db, env, notifications } = await setup(t);
	const result = await acceptSuggestion(env, manager, "sugg-phish", "mark_spam");
	assert.equal(result.status, "accepted");
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = 'msg-p'").get().status, "spam");
	assert.equal(statusOf(db, "sugg-phish"), "accepted");
	const repeat = await acceptSuggestion(env, manager, "sugg-phish", "mark_spam");
	assert.equal(repeat.actionId, result.actionId);
	const rows = actionRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].action, "move");
	assert.equal(rows[0].variant, "spam");
	assert.equal(rows[0].status, "applied");
	assert.equal(JSON.parse(rows[0].before).status, "received");
	assert.ok(notifications.some((item) => item.payload.suggestionId === "sugg-phish"));

	await undoAgentAction(env, owner, result.actionId);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = 'msg-p'").get().status, "received");
	assert.equal(statusOf(db, "sugg-phish"), "open");
});

test("dismiss is audited and undoable; muting adds the sender once and undo removes only that mute", async (t) => {
	const { db, env } = await setup(t);
	const result = await dismissSuggestion(env, manager, "sugg-reply", { muteSender: true });
	assert.equal(result.status, "dismissed");
	assert.equal(result.mutedSender, "sam@sender.test");
	assert.equal(statusOf(db, "sugg-reply"), "dismissed");
	assert.deepEqual(mutedSenders(db), ["old@sender.test", "sam@sender.test"]);
	const capabilities = JSON.parse(
		db.db.prepare("SELECT capabilities FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-a'").get().capabilities,
	);
	assert.equal(capabilities.calendar, false);
	const again = await dismissSuggestion(env, manager, "sugg-reply", {});
	assert.equal(again.actionId, result.actionId);
	assert.equal(actionRows(db).filter((row) => row.action === "dismiss" && row.status === "applied").length, 1);

	await undoAgentAction(env, owner, result.actionId);
	assert.equal(statusOf(db, "sugg-reply"), "open");
	assert.deepEqual(mutedSenders(db), ["old@sender.test"]);
	await assert.rejects(dismissSuggestion(env, manager, "sugg-reply", null), { status: 400 });
});

test("muting a sender who is already muted keeps the mute when the dismiss is undone", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE messages SET from_addr = 'Old <OLD@sender.test>' WHERE id = 'msg-a'");
	const result = await dismissSuggestion(env, owner, "sugg-reply", { muteSender: true });
	await undoAgentAction(env, owner, result.actionId);
	assert.deepEqual(mutedSenders(db), ["old@sender.test"]);
});

test("dismissing works after autonomy is turned off, but not once a suggestion is closed", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE mailbox_agent_settings SET autonomy = 'off' WHERE mailbox_id = 'mailbox-a'");
	const listed = await listSuggestions(env, owner, { mailboxId: "mailbox-a", status: "open" });
	assert.equal(listed.suggestions.length, 3);
	assert.equal((await dismissSuggestion(env, owner, "sugg-summary", {})).status, "dismissed");
	db.db.exec("UPDATE agent_suggestions SET status = 'superseded' WHERE id = 'sugg-reply'");
	await assert.rejects(dismissSuggestion(env, owner, "sugg-reply", {}), { status: 409 });
});

test("discarding a reply deletes its unedited agent draft and unlinks it, and undo reopens it without one", async (t) => {
	const { db, env } = await setup(t);
	const result = await dismissSuggestion(env, manager, "sugg-reply", { discardDraft: true });
	assert.equal(result.status, "dismissed");
	assert.equal(db.db.prepare("SELECT id FROM messages WHERE id = 'draft-a'").get(), undefined);
	assert.equal(db.db.prepare("SELECT draft_id FROM agent_suggestions WHERE id = 'sugg-reply'").get().draft_id, null);
	const [row] = actionRows(db).filter((item) => item.action === "dismiss");
	assert.equal(JSON.parse(row.after).discardedDraftId, "draft-a");

	await undoAgentAction(env, manager, result.actionId);
	assert.equal(statusOf(db, "sugg-reply"), "open");
	await assert.rejects(acceptSuggestion(env, owner, "sugg-reply", "review"), { status: 409 });
});

test("discarding keeps a draft a person edited, and plain dismiss keeps the draft", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(
		`INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, source_message_id, created_at, human_edited_at) VALUES ('draft-a', 'mailbox-a', 'auto', 'msg-a', 1, 2)`,
	);
	const result = await dismissSuggestion(env, owner, "sugg-reply", { discardDraft: true });
	assert.equal(result.status, "dismissed");
	assert.ok(db.db.prepare("SELECT id FROM messages WHERE id = 'draft-a'").get());
	const [row] = actionRows(db).filter((item) => item.action === "dismiss");
	assert.equal(JSON.parse(row.after).keptDraftId, "draft-a");

	db.db.exec(
		"DELETE FROM agent_draft_metadata; UPDATE agent_suggestions SET status = 'open' WHERE id = 'sugg-summary'",
	);
	await dismissSuggestion(env, owner, "sugg-summary", { discardDraft: true });
	assert.ok(db.db.prepare("SELECT id FROM messages WHERE id = 'draft-a'").get());
});
