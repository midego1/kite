import assert from "node:assert/strict";
import test from "node:test";
import { D1_BOUND_PARAMETER_LIMIT, jmap, jmapContext, limitBoundParameters } from "./support/jmap-database.mjs";

const { loadAttachmentsByMessage, loadMessages, processRequest } = jmap;

/**
 * D1 refuses a statement with more than 100 bound parameters, while `Email/get` serves up to 200 ids
 * and a key without a mailbox restriction reaches every mailbox its user can read. Each test runs the
 * real methods against a migrated SQLite database that refuses what D1 would refuse.
 */

const messageIds = (count, prefix = "msg") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);

function seedMessages(database, mailboxId, ids, threadOf = (id) => id) {
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, thread_id, created_at) VALUES
			${ids.map((id, index) => `('${id}', 'owner', '${mailboxId}', 'inbound', 'a@example.net', 'b@example.com', 'received', '${threadOf(id)}', ${index + 1})`).join(",\n\t\t\t")};
	`);
}

async function run(ctx, methodCalls) {
	const response = await processRequest(ctx, { using: ["urn:ietf:params:jmap:core"], methodCalls });
	return response.methodResponses;
}

test("Email/get answers 200 ids for a user with many mailboxes without exceeding D1's parameter cap", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t, { mailboxCount: 120 });
	const stored = messageIds(150);
	seedMessages(database, mailboxIds[7], stored);
	const missing = messageIds(50, "gone");
	const stats = limitBoundParameters(database);

	const [[name, result]] = await run(ctx, [["Email/get", { ids: [...stored, ...missing], properties: ["id"] }, "g"]]);
	assert.equal(name, "Email/get", JSON.stringify(result));
	assert.deepEqual(result.list.map((email) => email.id).sort(), stored);
	assert.deepEqual(result.notFound, missing);
	assert.ok(stats.maxBound <= D1_BOUND_PARAMETER_LIMIT, `bound ${stats.maxBound}`);
});

test("Email/get lists a repeated id once, also when its copies land in different batches", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t);
	const stored = messageIds(120);
	seedMessages(database, mailboxIds[0], stored);
	limitBoundParameters(database);

	const requested = [...stored, stored[0], stored[1], stored[60], "gone-1", "gone-1"];
	const [[name, result]] = await run(ctx, [["Email/get", { ids: requested, properties: ["id"] }, "g"]]);
	assert.equal(name, "Email/get", JSON.stringify(result));
	assert.equal(result.list.length, 120);
	assert.equal(new Set(result.list.map((email) => email.id)).size, 120);
	assert.deepEqual(result.notFound, ["gone-1"]);
	assert.equal((await loadMessages(ctx, requested)).length, 120);
});

test("Thread/get groups 150 threads with repeated ids once each, oldest message first", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t, { mailboxCount: 120 });
	const stored = messageIds(300);
	seedMessages(database, mailboxIds[0], stored, (id) => `thread-${Math.floor(Number(id.slice(4)) / 2)}`);
	const stats = limitBoundParameters(database);

	const threads = Array.from({ length: 150 }, (_, index) => `thread-${index}`);
	const requested = [...threads, threads[0], threads[149], "thread-missing"];
	const [[name, result]] = await run(ctx, [["Thread/get", { ids: requested }, "t"]]);
	assert.equal(name, "Thread/get", JSON.stringify(result));
	assert.equal(result.list.length, 150);
	assert.deepEqual(result.list.find((thread) => thread.id === "thread-0").emailIds, ["msg-0000", "msg-0001"]);
	assert.ok(result.list.every((thread) => thread.emailIds.length === 2));
	assert.deepEqual(result.notFound, ["thread-missing"]);
	assert.ok(stats.maxBound <= D1_BOUND_PARAMETER_LIMIT, `bound ${stats.maxBound}`);
});

test("attachments of a repeated message id are listed once", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t);
	const stored = messageIds(120);
	seedMessages(database, mailboxIds[0], stored);
	database.db.exec(`
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES
			('att-a', '${stored[0]}', 'a.txt', 'text/plain', 3, 'raw/att-a', 1),
			('att-b', '${stored[119]}', 'b.txt', 'text/plain', 3, 'raw/att-b', 1);
	`);
	limitBoundParameters(database);

	const attachments = await loadAttachmentsByMessage(ctx, [...stored, stored[0], stored[119]]);
	assert.deepEqual(
		attachments.get(stored[0]).map((row) => row.id),
		["att-a"],
	);
	assert.deepEqual(
		attachments.get(stored[119]).map((row) => row.id),
		["att-b"],
	);
});

test("Mailbox/get and Email/query work for a user with 120 mailboxes", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t, { mailboxCount: 120 });
	seedMessages(database, mailboxIds[119], messageIds(3));
	database.db.exec(
		`INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'owner', '${mailboxIds[119]}', 'Receipts', 1)`,
	);
	const stats = limitBoundParameters(database);

	const [[mailboxName, mailboxes], [queryName, query]] = await run(ctx, [
		["Mailbox/get", { ids: null }, "m"],
		["Email/query", { limit: 10 }, "q"],
	]);
	assert.equal(mailboxName, "Mailbox/get", JSON.stringify(mailboxes));
	const last = mailboxes.list.find((mailbox) => mailbox.id === mailboxIds[119]);
	assert.equal(last.totalEmails, 3);
	assert.ok(mailboxes.list.some((mailbox) => mailbox.id === `${mailboxIds[119]}~f~folder-1`));
	assert.equal(queryName, "Email/query", JSON.stringify(query));
	assert.deepEqual(query.ids.sort(), messageIds(3));
	assert.ok(stats.maxBound <= D1_BOUND_PARAMETER_LIMIT, `bound ${stats.maxBound}`);
});

test("a key restricted to some mailboxes still sees only those through the scope", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t, { mailboxCount: 3 });
	seedMessages(database, mailboxIds[0], ["mine"]);
	seedMessages(database, mailboxIds[1], ["theirs"]);
	ctx.auth.mailboxIds = [mailboxIds[0]];

	const [[, result]] = await run(ctx, [["Email/get", { ids: ["mine", "theirs"], properties: ["id"] }, "g"]]);
	assert.deepEqual(
		result.list.map((email) => email.id),
		["mine"],
	);
	assert.deepEqual(result.notFound, ["theirs"]);
});

test("serverFail tells the client nothing about the failed query, and the log keeps it", async (t) => {
	const { database, ctx } = await jmapContext(t);
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		if (/from "messages"/.test(sql)) throw new Error(`Failed query: ${sql} params: ["secret-param"]`);
		return prepare(sql);
	};
	const logged = t.mock.method(console, "error", () => undefined);

	const [[name, error]] = await run(ctx, [["Email/get", { ids: ["msg-1"] }, "g"]]);
	assert.equal(name, "error");
	assert.equal(error.type, "serverFail");
	assert.doesNotMatch(JSON.stringify(error), /select|params|secret-param|messages/i);
	assert.equal(logged.mock.callCount(), 1);
	assert.match(String(logged.mock.calls[0].arguments[1]), /secret-param/);
});
