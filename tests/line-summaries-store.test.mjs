import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, applyMigrations, createDb, lineGateFor, loadRowLines, resolveMailboxAgentSettings, saveLine } =
	await bundleModules("kite-line-summaries-store-", [
		["SqliteDatabase", "server/runtime/sqlite-database.ts"],
		["applyMigrations", "server/runtime/migrate.ts"],
		["createDb", "src/db/index.ts"],
		["lineGateFor, loadRowLines, saveLine", "src/lib/agent/summaries/lines.ts"],
		["resolveMailboxAgentSettings", "src/lib/agent/auto-read/settings-utils.ts"],
	]);

const scratch = makeBundleDirectory("kite-line-summaries-store-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	seedAccountData(db);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, spam_verdict, created_at) VALUES
			('message-2', 'owner', 'mailbox-a', 'inbound', 'customer@example.net', 'a@example.com', 'Re: Question', 'More', 'received', 'thread-1', 'inbox', 5),
			('spam-1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Win', 'Win', 'spam', NULL, 'spam', 6),
			('junk-1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Junk', 'Junk', 'received', NULL, 'spam', 7);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, updated_at, list_summaries) VALUES ('mailbox-a', 1, 1, 1);
	`);
	return db;
}

const line = (id, text, threadId = "thread-1") => ({
	source: { id, mailboxId: "mailbox-a", threadId },
	text,
	from: "line_job",
	modelId: "fake",
});
const lines = (db) =>
	db.db.prepare("SELECT message_id, text, kind, source FROM ai_summaries ORDER BY message_id").all();

test("a line is saved once, only for mail still in the Inbox and not judged spam", async (t) => {
	const db = await database(t);
	assert.equal(await saveLine(db, line("message-1", "First line.")), true);
	assert.equal(await saveLine(db, { ...line("message-1", "Second try."), from: "triage" }), false);
	assert.equal(await saveLine(db, line("spam-1", "Spam.", null)), false);
	assert.equal(await saveLine(db, line("junk-1", "Junk.", null)), false);
	assert.deepEqual(lines(db), [{ message_id: "message-1", text: "First line.", kind: "line", source: "line_job" }]);
	const [row] = db.db.prepare("SELECT thread_key, language, instructions_digest FROM ai_summaries").all();
	assert.deepEqual(row, { thread_key: "thread-1", language: "und", instructions_digest: "" });
});

test("moving a message to Trash or deleting it removes its line", async (t) => {
	const db = await database(t);
	await saveLine(db, line("message-1", "First."));
	await saveLine(db, line("message-2", "Second."));
	db.db.exec("UPDATE messages SET status = 'trash' WHERE id = 'message-1'");
	db.db.exec("DELETE FROM messages WHERE id = 'message-2'");
	assert.deepEqual(lines(db), []);
});

test("the list gets each row's line, a conversation row its newest message's, and nothing with the setting off", async (t) => {
	const db = await database(t);
	await saveLine(db, line("message-1", "Older line."));
	await saveLine(db, line("message-2", "Newer line."));
	const appDb = createDb(db);
	const rows = [
		{ id: "message-1", mailboxId: "mailbox-a" },
		{ id: "message-2", mailboxId: "mailbox-a" },
		{ id: "template-1", mailboxId: "mailbox-a" },
	];
	const single = await loadRowLines(appDb, rows, (row) => [row.id]);
	assert.deepEqual(
		rows.map((row) => single(row.id)),
		[{ lineSummary: "Older line." }, { lineSummary: "Newer line." }, {}],
	);
	const grouped = await loadRowLines(appDb, rows.slice(0, 1), () => ["message-1", "message-2"]);
	assert.deepEqual(grouped("message-1"), { lineSummary: "Newer line." });
	db.db.exec("UPDATE mailbox_agent_settings SET list_summaries = 0");
	assert.deepEqual((await loadRowLines(appDb, rows, (row) => [row.id]))("message-1"), {});
	assert.deepEqual((await loadRowLines(appDb, [], (row) => [row.id]))("message-1"), {});
});

test("before migration 0072 the list has no lines and nothing fails", async (t) => {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, copyMigrationsBefore(scratch, 72));
	seedAccountData(db);
	db.db.exec("INSERT INTO mailbox_agent_settings (mailbox_id, enabled, updated_at) VALUES ('mailbox-a', 1, 1)");
	const get = await loadRowLines(createDb(db), [{ id: "message-1", mailboxId: "mailbox-a" }], (row) => [row.id]);
	assert.deepEqual(get("message-1"), {});
});

test("the daily limit counts every request that asked for a line, usable answer or not", async (t) => {
	const db = await database(t);
	const appDb = createDb(db);
	const context = { mailboxId: "mailbox-a", ownerUserId: "owner", mailboxType: "personal" };
	const settings = {
		...resolveMailboxAgentSettings(undefined, context),
		listSummaries: true,
		listSummaryDailyLimit: 2,
	};
	const source = db.db.prepare("SELECT * FROM messages WHERE id = 'message-2'").get();
	const input = {
		settings,
		source: {
			id: source.id,
			mailboxId: source.mailbox_id,
			threadId: source.thread_id,
			status: "received",
			spamVerdict: "inbox",
			fromAddr: source.from_addr,
		},
		mailbox: { id: "mailbox-a", userId: "owner", domainId: "domain-1", localPart: "a", type: "personal" },
		facts: {
			automatic: false,
			bulk: false,
			noReply: false,
			senderAddress: "customer@example.net",
			bodyLength: 600,
			spamVerdict: "inbox",
			phishingSignals: [],
		},
	};
	const now = Math.floor(Date.now() / 1000);
	const usage = (id, source) =>
		db.db.exec(
			`INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, mailbox_id) VALUES ('${id}', ${now}, 'compatible', 'fake', '${source}', 10, 5, 'mailbox-a')`,
		);
	assert.equal(await lineGateFor(appDb, input), null);
	// A triage request that did not ask for a line does not count; one that did counts, even without a line.
	usage("u1", "auto_triage");
	usage("u2", "auto_triage_line");
	assert.equal(await lineGateFor(appDb, input), null);
	usage("u3", "line_summary");
	assert.deepEqual(db.db.prepare("SELECT count(*) AS n FROM ai_summaries").all(), [{ n: 0 }]);
	assert.equal(await lineGateFor(appDb, input), "daily_limit");
	assert.equal(await lineGateFor(appDb, { ...input, settings: { ...settings, listSummaryDailyLimit: 3 } }), null);
	assert.equal(
		await lineGateFor(appDb, {
			...input,
			facts: { ...input.facts, phishingSignals: ["display_name_spoof"] },
			settings: { ...settings, listSummaryDailyLimit: 3 },
		}),
		"phishing",
	);
});
