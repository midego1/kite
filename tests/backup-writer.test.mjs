import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-backup-writer-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FixedPartBuffer } from "./src/lib/backups/backup-writer-utils.ts";
			export { writeBackupObject } from "./src/lib/backups/backup-writer.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords, streamDatabaseSnapshot } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "backup-writer-test-entry.ts",
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
const helpers = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const decoder = new TextDecoder();

async function* fromStrings(strings) {
	for (const value of strings) yield value;
}

function multipartBucket() {
	const calls = { puts: [], parts: [], completed: null, aborted: false };
	return {
		calls,
		async put(key, value) {
			calls.puts.push({ key, value: decoder.decode(value) });
			return { size: value.byteLength };
		},
		async createMultipartUpload(key) {
			return {
				async uploadPart(number, value) {
					calls.parts.push({ number, value: decoder.decode(value) });
					return { partNumber: number, etag: `e${number}` };
				},
				async complete(parts) {
					calls.completed = { key, parts };
				},
				async abort() {
					calls.aborted = true;
				},
			};
		},
	};
}

test("FixedPartBuffer cuts exact parts across chunk boundaries", () => {
	const buffer = new helpers.FixedPartBuffer(4);
	const encoder = new TextEncoder();
	buffer.push(encoder.encode("ab"));
	assert.equal(buffer.takePart(), null);
	buffer.push(encoder.encode("cdefghij"));
	assert.equal(decoder.decode(buffer.takePart()), "abcd");
	assert.equal(decoder.decode(buffer.takePart()), "efgh");
	assert.equal(buffer.takePart(), null);
	assert.equal(decoder.decode(buffer.takeRest()), "ij");
	assert.equal(buffer.length, 0);
	assert.throws(() => new helpers.FixedPartBuffer(0), RangeError);
});

test("a small document is a single put", async () => {
	const bucket = multipartBucket();
	const result = await helpers.writeBackupObject(bucket, "k", fromStrings(["{", "}"]), {}, 16);
	assert.deepEqual(bucket.calls.puts, [{ key: "k", value: "{}" }]);
	assert.equal(bucket.calls.parts.length, 0);
	assert.equal(result.size, 2);
});

test("a large document streams as equal-sized parts plus a shorter last one", async () => {
	const bucket = multipartBucket();
	const pieces = Array.from({ length: 30 }, (_, index) => `row-${index};`);
	const result = await helpers.writeBackupObject(bucket, "k", fromStrings(pieces), {}, 16);
	const parts = bucket.calls.parts;
	assert.ok(parts.length > 2);
	assert.ok(parts.slice(0, -1).every((part) => part.value.length === 16));
	assert.ok(parts.at(-1).value.length <= 16);
	assert.deepEqual(
		parts.map((part) => part.number),
		parts.map((_, index) => index + 1),
	);
	assert.equal(parts.map((part) => part.value).join(""), pieces.join(""));
	assert.equal(bucket.calls.completed.parts.length, parts.length);
	assert.equal(bucket.calls.puts.length, 0);
	assert.equal(result.size, pieces.join("").length);
});

test("a failure while producing the document aborts the upload", async () => {
	const bucket = multipartBucket();
	async function* failing() {
		yield "x".repeat(40);
		throw new Error("database went away");
	}
	await assert.rejects(helpers.writeBackupObject(bucket, "k", failing(), {}, 16), /database went away/);
	assert.equal(bucket.calls.aborted, true);
	assert.equal(bucket.calls.completed, null);
});

test("a bucket without multipart support gets one put", async () => {
	const puts = [];
	const bucket = {
		async put(key, value) {
			puts.push(decoder.decode(value));
			return { size: value.byteLength };
		},
	};
	await helpers.writeBackupObject(bucket, "k", fromStrings(["a".repeat(40), "b"]), {}, 16);
	assert.deepEqual(puts, ["a".repeat(40) + "b"]);
});

test("exports page through tables larger than one query and still restore", async (t) => {
	const db = new helpers.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await helpers.applyMigrations(db, join(root, "drizzle/migrations"));
	const insert = db.db.prepare(
		"INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', ?, 'user', 1)",
	);
	for (let index = 0; index < 250; index += 1)
		insert.run(`u${String(index).padStart(3, "0")}`, `user${index}@example.test`, `User ${index}`);

	const exported = JSON.parse(decoder.decode(await helpers.exportDatabaseRecords(db)));
	assert.equal(exported.format, "kite-database-backup");
	assert.equal(exported.tables.users.length, 250);
	assert.equal(new Set(exported.tables.users.map((row) => row.id)).size, 250);
	assert.ok(exported.tables.users.every((row) => !("__kite_rowid" in row)));
	assert.deepEqual(Object.keys(exported.tables.users[0]).slice(0, 2), ["id", "email"]);

	let snapshot = "";
	for await (const chunk of await helpers.streamDatabaseSnapshot(db)) snapshot += chunk;
	assert.equal(JSON.parse(snapshot).tables.users.length, 250);

	db.db.exec("DELETE FROM users");
	await helpers.restoreDatabaseRecords(db, new TextEncoder().encode(JSON.stringify(exported)).buffer);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM users").get().count, 250);
});
