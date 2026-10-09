import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-data-safety-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { InProcessQueue } from "./server/runtime/queue.ts";
			export * from "./server/runtime/queue-utils.ts";
			export * from "./src/lib/backups/restore-utils.ts";
			export * from "./src/lib/mailboxes/delete-utils.ts";
			export { runPostDeliveryStep } from "./src/lib/email/post-delivery-utils.ts";
			export { matchesTypedConfirmation, requestConfirmation, settleConfirmation, subscribeToConfirmations } from "./src/components/ui/confirm-dialog-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "data-safety-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const lib = await import(pathToFileURL(join(directory, "entry.mjs")).href);

let databaseCount = 0;
function openDatabase() {
	return new lib.SqliteDatabase(join(directory, `db-${databaseCount++}.sqlite`));
}

const silence = () => {
	const original = console.error;
	console.error = () => {};
	return () => {
		console.error = original;
	};
};

test("sqlite batch rolls back every statement when one fails", async () => {
	const database = openDatabase();
	database.db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
	await database.prepare("INSERT INTO items (id, name) VALUES (1, 'kept')").run();
	await assert.rejects(
		database.batch([
			database.prepare("DELETE FROM items"),
			database.prepare("INSERT INTO items (id, name) VALUES (?, ?)").bind(2, "new"),
			database.prepare("INSERT INTO items (id, name) VALUES (?, ?)").bind(3, null),
		]),
	);
	assert.deepEqual(database.db.prepare("SELECT id, name FROM items").all(), [{ id: 1, name: "kept" }]);
	const results = await database.batch([
		database.prepare("INSERT INTO items (id, name) VALUES (4, 'x')"),
		database.prepare("SELECT COUNT(*) AS n FROM items"),
	]);
	assert.equal(results[1].results[0].n, 2);
	database.db.close();
});

test("restore plan deletes children first, inserts parents first and stays under the parameter limit", () => {
	const parents = Array.from({ length: 60 }, (_, index) => ({ id: `p${index}`, name: `parent ${index}` }));
	const children = [{ id: "c1", parentId: "p1", dropped: "old column" }];
	const { deletes, inserts } = lib.planRestoreStatements([
		{ name: "parents", rows: parents, columns: new Set(["id", "name"]) },
		{ name: "children", rows: children, columns: new Set(["id", "parentId"]) },
	]);
	assert.deepEqual(
		deletes.map((statement) => statement.sql),
		["DELETE FROM `children`", "DELETE FROM `parents`"],
	);
	for (const statement of inserts) assert.ok(statement.params.length <= lib.MAX_BOUND_PARAMETERS);
	const parentInserts = inserts.filter((statement) => statement.sql.startsWith("INSERT INTO `parents`"));
	assert.equal(parentInserts.length, 2);
	assert.equal(
		parentInserts.reduce((total, statement) => total + statement.params.length, 0),
		120,
	);
	assert.ok(
		inserts.indexOf(parentInserts[0]) <
			inserts.findIndex((statement) => statement.sql.startsWith("INSERT INTO `children`")),
	);
	const childInsert = inserts.at(-1);
	assert.equal(childInsert.sql, "INSERT INTO `children` (`id`, `parentId`) VALUES (?, ?)");
	assert.deepEqual(childInsert.params, ["c1", "p1"]);
});

test("restore plan splits rows with different columns and rejects empty rows", () => {
	const { inserts } = lib.planRestoreStatements([{ name: "t", rows: [{ a: 1 }, { a: 2 }, { a: 3, b: 4 }] }]);
	assert.equal(inserts.length, 2);
	assert.deepEqual(inserts[0].params, [1, 2]);
	assert.deepEqual(inserts[1].params, [3, 4]);
	assert.throws(
		() => lib.planRestoreStatements([{ name: "t", rows: [{ gone: 1 }], columns: new Set(["a"]) }]),
		/invalid t record/,
	);
});

test("restore chunks respect statement and byte limits and report atomicity", () => {
	const statements = Array.from({ length: 7 }, (_, index) => ({
		sql: "INSERT INTO t VALUES (?)",
		params: [`row-${index}`],
	}));
	const chunks = lib.chunkRestoreStatements(statements, { maxStatements: 3, maxBytes: 1_000_000 });
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[3, 3, 1],
	);
	const bytes = lib.estimateStatementBytes(statements[0]);
	assert.deepEqual(
		lib.chunkRestoreStatements(statements, { maxStatements: 100, maxBytes: bytes * 2 }).map((chunk) => chunk.length),
		[2, 2, 2, 1],
	);
	const small = lib.createRestorePlan(statements.slice(0, 2), 2);
	assert.equal(small.atomic, true);
	const appended = lib.appendToRestorePlan(small, [{ sql: "INSERT INTO backups VALUES (?)", params: ["keep"] }]);
	assert.equal(appended.atomic, true);
	assert.equal(appended.chunks[0].at(-1).params[0], "keep");
	assert.equal(lib.createRestorePlan(statements, 7, { maxStatements: 3, maxBytes: 1_000_000 }).atomic, false);
});

test("restore plan applied in one sqlite batch replaces the data", async () => {
	const database = openDatabase();
	database.db.exec(
		"CREATE TABLE parents (id TEXT PRIMARY KEY); CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE)",
	);
	database.db.exec("INSERT INTO parents VALUES ('old'); INSERT INTO children VALUES ('old-child', 'old')");
	const { deletes, inserts } = lib.planRestoreStatements([
		{ name: "parents", rows: [{ id: "p" }] },
		{ name: "children", rows: [{ id: "c", parent_id: "p" }] },
	]);
	const plan = lib.createRestorePlan([...deletes, ...inserts], 2);
	await database.batch(plan.chunks[0].map((statement) => database.prepare(statement.sql).bind(...statement.params)));
	assert.deepEqual(database.db.prepare("SELECT id, parent_id FROM children").all(), [{ id: "c", parent_id: "p" }]);
	database.db.close();
});

test("mailbox purge keeps raw objects other messages still use", () => {
	assert.deepEqual(lib.selectDeletableRawKeys(["a", null, "b", "a", "shared"], ["shared"]), ["a", "b"]);
	assert.deepEqual(lib.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.equal(lib.isMailboxPurgeMessage({ kind: "mailbox.purge", mailboxId: "m1" }), true);
	assert.equal(lib.isMailboxPurgeMessage({ kind: "mailbox.purge" }), false);
	assert.equal(lib.isMailboxPurgeMessage({ messageId: "x" }), false);
	assert.ok(lib.MAILBOX_PURGE_BATCH_SIZE * 2 <= 100);
});

test("post-delivery steps never throw", async () => {
	const restore = silence();
	try {
		assert.equal(await lib.runPostDeliveryStep("ok", async () => {}), true);
		assert.equal(
			await lib.runPostDeliveryStep("broken", async () => {
				throw new Error("webhook down");
			}),
			false,
		);
	} finally {
		restore();
	}
});

test("typed confirmation ignores case and surrounding space", () => {
	assert.equal(lib.matchesTypedConfirmation(undefined, ""), true);
	assert.equal(lib.matchesTypedConfirmation("Example.com", " example.COM "), true);
	assert.equal(lib.matchesTypedConfirmation("example.com", "example.co"), false);
});

test("confirmation requests are shown one at a time in order", async () => {
	const shown = [];
	const unsubscribe = lib.subscribeToConfirmations((pending) => shown.push(pending?.title ?? null));
	const first = lib.requestConfirmation({ title: "first" });
	const second = lib.requestConfirmation({ title: "second" });
	assert.deepEqual(shown, [null, "first"]);
	let pendingId;
	const capture = lib.subscribeToConfirmations((pending) => {
		pendingId = pending?.id;
	});
	lib.settleConfirmation(pendingId, true);
	assert.equal(await first, true);
	assert.deepEqual(shown, [null, "first", "second"]);
	lib.settleConfirmation(pendingId, false);
	assert.equal(await second, false);
	capture();
	unsubscribe();
});

test("queue helpers pick retry and wake timings", () => {
	assert.equal(lib.shouldRetryQueueMessage(0, 3), true);
	assert.equal(lib.shouldRetryQueueMessage(3, 3), false);
	assert.equal(lib.getQueueWakeDelayMs(null, 0), null);
	assert.equal(lib.getQueueWakeDelayMs(500, 1000), 0);
	assert.equal(lib.getQueueWakeDelayMs(1500, 1000), 500);
	assert.equal(lib.getQueueWakeDelayMs(Number.MAX_SAFE_INTEGER, 0), 2_147_483_647);
});

test("queued messages survive a restart and run once a consumer is attached", async () => {
	const database = openDatabase();
	const producer = new lib.InProcessQueue("outbound", database.db);
	await producer.send({ n: 1 });
	await producer.send({ n: 2 });
	assert.deepEqual(await producer.metrics(), { backlogCount: 2 });
	producer.stop();

	const restarted = new lib.InProcessQueue("outbound", database.db);
	const other = new lib.InProcessQueue("inbound", database.db);
	await other.send({ other: true });
	const received = [];
	restarted.setConsumer(async (body) => {
		received.push(body);
	});
	await restarted.drain();
	assert.deepEqual(received.map((body) => body.n).sort(), [1, 2]);
	assert.deepEqual(await restarted.metrics(), { backlogCount: 0 });
	assert.deepEqual(await other.metrics(), { backlogCount: 1 });
	restarted.stop();
	other.stop();
	database.db.close();
});

test("delayed messages wait for their time and failures retry then give up", async () => {
	const database = openDatabase();
	let now = 1_000_000;
	const queue = new lib.InProcessQueue("jobs", database.db, { maxRetries: 2, retryDelayMs: 50, now: () => now });
	const restore = silence();
	try {
		const seen = [];
		queue.setConsumer(async (body) => {
			seen.push(body.id);
			if (body.id === "fail") throw new Error("boom");
		});
		await queue.send({ id: "later" }, { delaySeconds: 60 });
		await queue.drain();
		assert.deepEqual(seen, []);
		assert.equal(database.db.prepare("SELECT available_at FROM node_queue_messages").get().available_at, 1_060_000);

		now += 60_000;
		queue.setConsumer(queue["consumer"]);
		await queue.drain();
		assert.deepEqual(seen, ["later"]);

		await queue.send({ id: "fail" });
		await queue.drain();
		for (let retry = 0; retry < 2; retry++) {
			now += 50;
			queue.setConsumer(queue["consumer"]);
			await queue.drain();
		}
		assert.deepEqual(seen, ["later", "fail", "fail", "fail"]);
		assert.deepEqual(await queue.metrics(), { backlogCount: 0 });
	} finally {
		restore();
		queue.stop();
		database.db.close();
	}
});
