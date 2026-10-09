import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const directory = makeBundleDirectory("kite-legacy-import-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { sealSecret } from "./src/lib/security/secret-box.ts";
			export { getLegacyImportStatus, LegacyImportError, runLegacyImportStep, startLegacyImport } from "./src/lib/legacy-import/service.ts";
			export { repointRule, routesToWorker, ruleAddress } from "./src/lib/legacy-import/routing-utils.ts";
			export { renameRouteForWorker } from "./src/lib/cloudflare-api-utils.ts";
			export { selectCopyTables, isCopyableObjectKey, totalCopiedRows } from "./src/lib/legacy-import/copy-utils.ts";
			export { describeLegacyImportPhase, describeLegacyRoutes, legacyImportFraction, summarizeLegacyImport } from "./src/components/legacy-import-card-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "legacy-import-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const kite = await import(pathToFileURL(join(directory, "entry.mjs")).href);

class MemoryBucket {
	objects = new Map();

	async put(key, value, options = {}) {
		const bytes =
			typeof value === "string"
				? new TextEncoder().encode(value)
				: value instanceof Uint8Array
					? value
					: value instanceof ArrayBuffer
						? new Uint8Array(value)
						: new Uint8Array(await new Response(value).arrayBuffer());
		this.objects.set(key, { bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
		return { key, size: bytes.byteLength };
	}

	async get(key) {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			key,
			size: object.bytes.byteLength,
			httpMetadata: object.httpMetadata,
			customMetadata: object.customMetadata,
			body: new Blob([object.bytes]).stream(),
			text: async () => new TextDecoder().decode(object.bytes),
		};
	}

	async head(key) {
		const object = this.objects.get(key);
		return object ? { key, size: object.bytes.byteLength } : null;
	}

	async list({ limit = 1000, cursor } = {}) {
		const keys = [...this.objects.keys()].sort();
		const start = cursor ? Number(cursor) : 0;
		const truncated = start + limit < keys.length;
		return {
			objects: keys.slice(start, start + limit).map((key) => ({ key, size: this.objects.get(key).bytes.byteLength })),
			truncated,
			cursor: truncated ? String(start + limit) : undefined,
		};
	}
}

let databaseCount = 0;
async function migratedDatabase() {
	const database = new kite.SqliteDatabase(join(directory, `db-${(databaseCount += 1)}.sqlite`));
	await kite.applyMigrations(database, migrationsDir);
	return database;
}

/** Inserts a row, filling NOT NULL columns without a default so the test only names what it checks. */
function insertRow(database, table, values) {
	const row = { ...values };
	for (const column of database.db.prepare(`PRAGMA table_info(${table})`).all()) {
		if (column.notnull && column.dflt_value === null && !column.pk && row[column.name] === undefined)
			row[column.name] =
				column.name === "user_id" ? "usr_old" : /INT/i.test(column.type) ? 1 : `${column.name}-${values.id ?? "x"}`;
	}
	const columns = Object.keys(row);
	database.db
		.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.run(...columns.map((column) => row[column]));
}

function count(database, table) {
	return database.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}

async function seedOldInstall() {
	const source = await migratedDatabase();
	insertRow(source, "users", { id: "usr_old", email: "owner@example.test", name: "Owner", role: "admin" });
	insertRow(source, "domains", { id: "dom_1", user_id: "usr_old", hostname: "example.test", zone_id: "zone-1" });
	insertRow(source, "mailboxes", {
		id: "mbx_1",
		user_id: "usr_old",
		domain_id: "dom_1",
		local_part: "owner",
	});
	for (let index = 0; index < 120; index += 1)
		insertRow(source, "contacts", { id: `con_${index}`, user_id: "usr_old", email: `person${index}@example.test` });
	insertRow(source, "messages", {
		id: "msg_1",
		mailbox_id: "mbx_1",
		direction: "inbound",
		from_addr: "person0@example.test",
		to_addr: "owner@example.test",
		subject: "Lighthouse schedule",
		status: "received",
		raw_r2_key: "inbound/1-abc.eml",
	});
	source.db
		.prepare("UPDATE app_settings SET agent_api_key = ? WHERE id = 'default'")
		.run(await kite.sealSecret("old-key", "sk-old"));
	const bucket = new MemoryBucket();
	await bucket.put("inbound/1-abc.eml", "Subject: Lighthouse schedule\r\n\r\nHello", {
		httpMetadata: { contentType: "message/rfc822" },
	});
	for (let index = 0; index < 30; index += 1) await bucket.put(`attachments/${index}.txt`, `file ${index}`);
	return { source, bucket };
}

async function runToEnd(env, mode) {
	const { token, run } = await kite.startLegacyImport(env, mode, null);
	let current = run;
	let steps = 0;
	while (current.phase !== "done") {
		current = await kite.runLegacyImportStep(env, token, current.step);
		assert.ok((steps += 1) < 100, "the copy does not finish");
	}
	return { token, run: current, steps };
}

test("a full copy replaces this install with the old one's rows and files", async () => {
	const { source, bucket } = await seedOldInstall();
	const target = await migratedDatabase();
	insertRow(target, "users", { id: "usr_setup", email: "setup@example.test", name: "Setup", role: "admin" });
	const env = {
		DB: target,
		BUCKET: new MemoryBucket(),
		LEGACY_DB: source,
		LEGACY_BUCKET: bucket,
		APP_ENCRYPTION_KEY: "new-key",
	};

	const { run, steps } = await runToEnd(env, "full");

	assert.ok(steps > 3, "rows and files are copied over several bounded steps");
	assert.deepEqual(
		target.db
			.prepare("SELECT id FROM users")
			.all()
			.map((row) => row.id),
		["usr_old"],
	);
	assert.equal(count(target, "contacts"), 120);
	assert.equal(run.progress.contacts.written, 120);
	assert.equal(
		target.db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'lighthouse'").all().length,
		1,
		"the search index is rebuilt by its triggers",
	);
	assert.equal(run.files.copied, 31);
	const raw = await env.BUCKET.get("inbound/1-abc.eml");
	assert.equal(raw.httpMetadata.contentType, "message/rfc822");
	assert.match(await raw.text(), /Lighthouse/);
	assert.ok(run.safetyBackupKey, "the replaced data is kept in a safety backup");
	assert.deepEqual(run.unreadableSecrets, ["Assistant provider API key"]);
	assert.deepEqual(run.problems, []);
	assert.equal("tokenHash" in run, false);
});

test("a catch-up copy adds only what is new and keeps mail that already arrived here", async () => {
	const { source, bucket } = await seedOldInstall();
	const target = await migratedDatabase();
	const env = {
		DB: target,
		BUCKET: new MemoryBucket(),
		LEGACY_DB: source,
		LEGACY_BUCKET: bucket,
		APP_ENCRYPTION_KEY: "old-key",
	};
	await runToEnd(env, "full");

	insertRow(source, "messages", {
		id: "msg_old_late",
		mailbox_id: "mbx_1",
		direction: "inbound",
		from_addr: "a@example.test",
		to_addr: "owner@example.test",
		status: "received",
	});
	insertRow(target, "messages", {
		id: "msg_new_here",
		mailbox_id: "mbx_1",
		direction: "inbound",
		from_addr: "b@example.test",
		to_addr: "owner@example.test",
		status: "received",
	});
	await bucket.put("inbound/2-late.eml", "late");

	const { run } = await runToEnd(env, "catch-up");

	assert.deepEqual(
		target.db
			.prepare("SELECT id FROM messages ORDER BY id")
			.all()
			.map((row) => row.id),
		["msg_1", "msg_new_here", "msg_old_late"],
	);
	assert.equal(run.progress.messages.written, 1);
	assert.equal(run.progress.contacts.skipped, 120);
	assert.equal(run.files.copied, 1);
	assert.equal(run.files.skipped, 31);
	assert.deepEqual(run.unreadableSecrets, [], "the same key reads the old secrets");
	assert.deepEqual(kite.totalCopiedRows(run).written, 1);
});

test("steps need the token of the run, and a repeated step does no work", async () => {
	const { source, bucket } = await seedOldInstall();
	const target = await migratedDatabase();
	const env = { DB: target, BUCKET: new MemoryBucket(), LEGACY_DB: source, LEGACY_BUCKET: bucket };
	const { token, run } = await kite.startLegacyImport(env, "catch-up", null);

	await assert.rejects(kite.runLegacyImportStep(env, "x".repeat(43), run.step), (error) => error.status === 403);
	const first = await kite.runLegacyImportStep(env, token, run.step);
	const repeated = await kite.runLegacyImportStep(env, token, run.step);
	assert.equal(repeated.step, first.step);
	assert.deepEqual(repeated.progress, first.progress);

	const status = await kite.getLegacyImportStatus(env);
	assert.equal(status.available, true);
	assert.equal(status.source.messages, 1);
	assert.equal(status.run.id, run.id);
});

test("the copy refuses an old database without Kite data, and is unavailable without the bindings", async () => {
	const target = await migratedDatabase();
	const empty = new kite.SqliteDatabase(join(directory, "empty.sqlite"));
	const env = { DB: target, BUCKET: new MemoryBucket(), LEGACY_DB: empty, LEGACY_BUCKET: new MemoryBucket() };
	await assert.rejects(kite.startLegacyImport(env, "full", null), (error) => error.status === 409);
	assert.deepEqual(await kite.getLegacyImportStatus({ DB: target, BUCKET: new MemoryBucket() }), {
		available: false,
		source: null,
		run: null,
	});
});

test("copy helpers keep the parent-first order and leave the copy's own state alone", () => {
	assert.deepEqual(
		kite.selectCopyTables(
			["users", "domains", "messages"],
			new Set(["messages", "users"]),
			new Set(["users", "domains", "messages"]),
		),
		["users", "messages"],
	);
	assert.equal(kite.isCopyableObjectKey("legacy-import/state.json"), false);
	assert.equal(kite.isCopyableObjectKey("inbound/1.eml"), true);
});

test("routing rules move from the old Worker without touching other actions or custom names", () => {
	const rule = {
		id: "r1",
		actions: [{ type: "worker", value: ["mailflare"] }],
		enabled: false,
		matchers: [{ type: "literal", field: "to", value: "owner@example.test" }],
		name: "Route owner@example.test to mailflare",
		priority: 3,
	};
	assert.equal(kite.routesToWorker(rule, ["mailflare"]), true);
	assert.equal(kite.ruleAddress(rule), "owner@example.test");
	assert.deepEqual(kite.repointRule(rule, "kite", ["mailflare"]), {
		actions: [{ type: "worker", value: ["kite"] }],
		enabled: false,
		matchers: rule.matchers,
		name: "Route owner@example.test to kite",
		priority: 3,
	});
	const forward = {
		actions: [{ type: "forward", value: ["me@example.org"] }],
		matchers: [{ type: "all" }],
		name: "My rule",
	};
	assert.equal(kite.routesToWorker(forward, ["mailflare"]), false);
	assert.equal(kite.ruleAddress(forward), "*");
	assert.deepEqual(kite.repointRule(forward, "kite", ["mailflare"]).actions, forward.actions);
	assert.equal(kite.renameRouteForWorker("My rule", "kite", ["mailflare"]), "My rule");
	assert.equal(kite.renameRouteForWorker(undefined, "kite", ["mailflare"]), undefined);
});

test("the card describes progress, results and routes in plain words", () => {
	const base = {
		mode: "full",
		phase: "tables",
		tables: ["users", "mailbox_access"],
		tableIndex: 1,
		files: { copied: 2, skipped: 0, bytes: 2048 },
		progress: { users: { read: 1, written: 1, skipped: 0 }, mailbox_access: { read: 3, written: 2, skipped: 1 } },
	};
	assert.equal(kite.describeLegacyImportPhase(base), "Copying mailbox access (2 of 2)");
	assert.equal(kite.describeLegacyImportPhase({ ...base, phase: "clear" }), "Emptying this install");
	assert.equal(kite.describeLegacyImportPhase({ ...base, phase: "files" }), "Copying files: 2 copied, 0 already here");
	assert.equal(kite.describeLegacyImportPhase({ ...base, phase: "done" }), "Done");
	assert.equal(kite.legacyImportFraction({ ...base, phase: "done" }), 1);
	assert.equal(kite.legacyImportFraction({ ...base, phase: "clear" }), 0.02);
	assert.equal(kite.legacyImportFraction({ ...base, phase: "files" }), 0.9);
	assert.equal(kite.legacyImportFraction({ ...base, phase: "files", files: { copied: 0, skipped: 0, bytes: 0 } }), 0.8);
	assert.equal(kite.legacyImportFraction(base), 0.425);
	assert.equal(kite.legacyImportFraction({ ...base, tables: [], tableIndex: 0 }), 0.8);
	assert.equal(kite.summarizeLegacyImport(base), "Copied 3 rows and 2 files (2.0 KB). 1 row was already here.");
	assert.equal(
		kite.summarizeLegacyImport({
			...base,
			progress: { users: { read: 1, written: 1, skipped: 0 } },
			files: { copied: 1, skipped: 0, bytes: 12 },
		}),
		"Copied 1 row and 1 file (12 B).",
	);
	const filesOf = (bytes) =>
		kite.summarizeLegacyImport({ ...base, progress: {}, files: { copied: 2, skipped: 0, bytes } });
	assert.equal(filesOf(5 * 1024 * 1024), "Copied 0 rows and 2 files (5.0 MB).");
	assert.equal(filesOf(300 * 1024), "Copied 0 rows and 2 files (300 KB).");
	const route = (address) => ({ zoneId: "z", hostname: "example.test", ruleId: null, address });
	assert.equal(
		kite.describeLegacyRoutes([route("a@example.test"), route("b@example.test"), route("*")]),
		"2 addresses and 1 catch-all",
	);
	assert.equal(kite.describeLegacyRoutes([route("a@example.test")]), "1 address");
	assert.equal(kite.describeLegacyRoutes([route("*"), route("*")]), "2 catch-alls");
});
