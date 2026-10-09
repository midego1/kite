import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-node-runtime-rename-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { adoptLegacyDatabaseFile } from "./server/runtime/data-files.ts";
			export { adoptQueueMessages, openQueue } from "./server/runtime/queue.ts";
		`,
		resolveDir: root,
		sourcefile: "node-runtime-rename-entry.ts",
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
const { default: Database } = await import("better-sqlite3");

function dataDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "kite-data-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a database under the pre-rename file name moves with its WAL", (t) => {
	const dir = dataDir(t);
	writeFileSync(join(dir, "mailflare.sqlite"), "main");
	writeFileSync(join(dir, "mailflare.sqlite-wal"), "wal");
	writeFileSync(join(dir, "mailflare.sqlite-shm"), "shm");

	assert.equal(helpers.adoptLegacyDatabaseFile(dir), join(dir, "kite.sqlite"));
	assert.equal(readFileSync(join(dir, "kite.sqlite"), "utf8"), "main");
	assert.equal(readFileSync(join(dir, "kite.sqlite-wal"), "utf8"), "wal");
	assert.equal(readFileSync(join(dir, "kite.sqlite-shm"), "utf8"), "shm");
	assert.equal(existsSync(join(dir, "mailflare.sqlite")), false);
	assert.equal(existsSync(join(dir, "mailflare.sqlite-wal")), false);
});

test("an existing Kite database is never replaced by a legacy file", (t) => {
	const dir = dataDir(t);
	writeFileSync(join(dir, "kite.sqlite"), "current");
	writeFileSync(join(dir, "mailflare.sqlite"), "legacy");

	assert.equal(helpers.adoptLegacyDatabaseFile(dir), join(dir, "kite.sqlite"));
	assert.equal(readFileSync(join(dir, "kite.sqlite"), "utf8"), "current");
	assert.equal(readFileSync(join(dir, "mailflare.sqlite"), "utf8"), "legacy");
});

test("a fresh data directory gets the Kite file name", (t) => {
	const dir = dataDir(t);
	assert.equal(helpers.adoptLegacyDatabaseFile(dir), join(dir, "kite.sqlite"));
	assert.equal(existsSync(join(dir, "kite.sqlite")), false);
});

test("messages queued under the old queue name are delivered by the renamed queue", async (t) => {
	const db = new Database(":memory:");
	t.after(() => db.close());
	const legacy = helpers.openQueue("mailflare-inbound", db);
	await legacy.send({ kind: "email.scheduled", jobId: "j1" });
	legacy.stop();

	helpers.adoptQueueMessages(db, "mailflare-inbound", "kite-inbound");
	const queue = helpers.openQueue("kite-inbound", db);
	t.after(() => queue.stop());
	assert.deepEqual(await queue.metrics(), { backlogCount: 1 });

	const received = [];
	queue.setConsumer(async (body) => received.push(body));
	await queue.drain();
	assert.deepEqual(received, [{ kind: "email.scheduled", jobId: "j1" }]);
	assert.deepEqual(await legacy.metrics(), { backlogCount: 0 });
});
