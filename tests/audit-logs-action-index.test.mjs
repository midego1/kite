import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-audit-index-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { auditLogs } from "./src/db/schema/index.ts";
			export { mcpAuditSliceCondition } from "./src/lib/maintenance/pruning.ts";
			export { MCP_TOOL_CALL_ACTION } from "./src/lib/mcp/audit.ts";
		`,
		resolveDir: root,
		sourcefile: "audit-logs-action-index-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const kite = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
const { and, desc, eq, inArray, lt } = await import("drizzle-orm");

const INDEX = "audit_logs_action_created_idx";

async function database(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-audit-index-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new kite.SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await kite.applyMigrations(database, join(root, "drizzle", "migrations"));
	// Planner statistics as on a real install: many rows of other actions, a few MCP ones.
	const insert = database.db.prepare("INSERT INTO audit_logs (id, action, created_at) VALUES (?, ?, ?)");
	database.db.transaction(() => {
		for (let i = 0; i < 3000; i++) insert.run(`a${i}`, i % 10 === 0 ? kite.MCP_TOOL_CALL_ACTION : `other.${i % 7}`, i);
	})();
	database.db.exec("ANALYZE");
	return { raw: database.db, db: kite.createDb(database) };
}

function plan(raw, query) {
	const { sql, params } = query.toSQL();
	return raw
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all(...params)
		.map((row) => row.detail);
}

const auditRows = (details) =>
	details.filter((detail) => /audit_logs/.test(detail) && !/^CORRELATED|^LIST/.test(detail));

test("the migration creates the (action, created_at) index", async (t) => {
	const { raw } = await database(t);
	const columns = raw.prepare(`PRAGMA index_info(${INDEX})`).all();
	assert.deepEqual(
		columns.map((column) => column.name),
		["action", "created_at"],
	);
});

test("the MCP tool call listing reads the index in order, without a sort", async (t) => {
	const { raw, db } = await database(t);
	// The shape of GET /api/audit-logs?action=mcp.tool_call, without the user and mailbox joins.
	const details = plan(
		raw,
		db
			.select({ id: kite.auditLogs.id })
			.from(kite.auditLogs)
			.where(eq(kite.auditLogs.action, kite.MCP_TOOL_CALL_ACTION))
			.orderBy(desc(kite.auditLogs.createdAt))
			.limit(100),
	);
	assert.ok(
		auditRows(details).some((detail) => detail.includes(INDEX)),
		details.join("\n"),
	);
	assert.ok(!details.some((detail) => /TEMP B-TREE/.test(detail)), details.join("\n"));
});

test("the listing of several actions finds its rows through an audit_logs index", async (t) => {
	const { raw, db } = await database(t);
	const details = plan(
		raw,
		db
			.select({ id: kite.auditLogs.id })
			.from(kite.auditLogs)
			.where(inArray(kite.auditLogs.action, ["auth.login", "auth.logout"]))
			.orderBy(desc(kite.auditLogs.createdAt))
			.limit(100),
	);
	assert.ok(
		auditRows(details).every((detail) => !/^SCAN audit_logs$/.test(detail)),
		details.join("\n"),
	);
	assert.ok(
		auditRows(details).some((detail) => detail.includes(INDEX)),
		details.join("\n"),
	);
});

test("the five-minute MCP prune reads its slice from the index", async (t) => {
	const { raw, db } = await database(t);
	const cutoff = new Date(2_000_000);
	const details = plan(
		raw,
		db.select({ id: kite.auditLogs.id }).from(kite.auditLogs).where(kite.mcpAuditSliceCondition(cutoff)).limit(500),
	);
	assert.ok(
		details.some((detail) =>
			detail.includes(`SEARCH audit_logs USING INDEX ${INDEX} (action=? AND created_at>? AND created_at<?)`),
		),
		details.join("\n"),
	);
});

test("the daily MCP prune reads everything older than the cutoff from the index", async (t) => {
	const { raw, db } = await database(t);
	const details = plan(
		raw,
		db
			.select({ id: kite.auditLogs.id })
			.from(kite.auditLogs)
			.where(
				and(eq(kite.auditLogs.action, kite.MCP_TOOL_CALL_ACTION), lt(kite.auditLogs.createdAt, new Date(2_000_000))),
			)
			.limit(500),
	);
	assert.ok(
		details.some((detail) => detail.includes(`SEARCH audit_logs USING INDEX ${INDEX} (action=? AND created_at<?)`)),
		details.join("\n"),
	);
});
