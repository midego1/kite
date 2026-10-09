import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-performance-helpers-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: [
			`export { chunkArray, queryInChunks, runInChunks, D1_MAX_BOUND_PARAMETERS, DEFAULT_IN_ARRAY_CHUNK_SIZE } from "./src/db/chunk-utils.ts";`,
			`export { encodeMessageCursor, decodeMessageCursor, getNextMessageCursor } from "./src/lib/messages/cursor-utils.ts";`,
			`export { getRetentionCutoff, shouldContinuePruning, PRUNING_BATCH_SIZE, PRUNING_MAX_BATCHES_PER_TABLE, PRUNING_POLICY } from "./src/lib/maintenance/pruning-utils.ts";`,
			`export { getAuthGuardDecision } from "./src/components/auth/auth-guard-utils.ts";`,
			`export { changesCurrentAccount } from "./src/lib/auth/client-utils.ts";`,
		].join("\n"),
		resolveDir: root,
		sourcefile: "performance-helpers-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const helpers = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("chunkArray splits into bounded chunks in order", () => {
	const items = Array.from({ length: 123 }, (_, index) => index);
	const chunks = helpers.chunkArray(items, 50);
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[50, 50, 23],
	);
	assert.deepEqual(chunks.flat(), items);
	assert.deepEqual(helpers.chunkArray([], 50), []);
	assert.throws(() => helpers.chunkArray(items, 0), RangeError);
	assert.ok(helpers.DEFAULT_IN_ARRAY_CHUNK_SIZE < helpers.D1_MAX_BOUND_PARAMETERS);
});

test("queryInChunks keeps every query under the bound-parameter limit and preserves order", async () => {
	const items = Array.from({ length: 260 }, (_, index) => `id${index}`);
	const sizes = [];
	const rows = await helpers.queryInChunks(items, async (chunk) => {
		sizes.push(chunk.length);
		return chunk.map((id) => ({ id }));
	});
	assert.ok(sizes.every((size) => size <= helpers.DEFAULT_IN_ARRAY_CHUNK_SIZE));
	assert.deepEqual(
		rows.map((row) => row.id),
		items,
	);
	let calls = 0;
	assert.deepEqual(
		await helpers.queryInChunks([], async () => {
			calls += 1;
			return [];
		}),
		[],
	);
	assert.equal(calls, 0);
});

test("runInChunks runs writes sequentially", async () => {
	const order = [];
	let active = 0;
	await helpers.runInChunks(
		Array.from({ length: 120 }, (_, index) => index),
		async (chunk) => {
			active += 1;
			assert.equal(active, 1);
			await new Promise((resolve) => setTimeout(resolve, 1));
			order.push(chunk[0]);
			active -= 1;
		},
		50,
	);
	assert.deepEqual(order, [0, 50, 100]);
});

test("message cursors round-trip and reject tampering", () => {
	const createdAt = new Date("2026-05-01T10:20:30.000Z");
	const encoded = helpers.encodeMessageCursor({ createdAt, id: "msg_abc:def" });
	assert.match(encoded, /^[A-Za-z0-9_-]+$/);
	const decoded = helpers.decodeMessageCursor(encoded);
	assert.equal(decoded.createdAt.getTime(), createdAt.getTime());
	assert.equal(decoded.id, "msg_abc:def");
	for (const bad of [
		"",
		null,
		undefined,
		"!!!",
		"x".repeat(600),
		Buffer.from("abc:").toString("base64url"),
		Buffer.from(":id").toString("base64url"),
		Buffer.from("12a:id").toString("base64url"),
	]) {
		assert.equal(helpers.decodeMessageCursor(bad), null, `expected ${bad} to be rejected`);
	}
});

test("getNextMessageCursor only continues after a full page", () => {
	const rows = [
		{ id: "b", createdAt: new Date(2_000_000) },
		{ id: "a", createdAt: new Date(1_000_000) },
	];
	assert.equal(helpers.getNextMessageCursor(rows, 3), null);
	assert.equal(helpers.getNextMessageCursor([], 0), null);
	const next = helpers.decodeMessageCursor(helpers.getNextMessageCursor(rows, 2));
	assert.equal(next.id, "a");
	assert.equal(next.createdAt.getTime(), 1_000_000);
});

test("retention cutoffs subtract whole days and refuse invalid input", () => {
	const now = new Date("2026-06-10T02:00:00.000Z");
	assert.equal(helpers.getRetentionCutoff(now, 30).toISOString(), "2026-05-11T02:00:00.000Z");
	assert.equal(helpers.getRetentionCutoff(now, 0).getTime(), now.getTime());
	assert.equal(helpers.getRetentionCutoff(now, -1), null);
	assert.equal(helpers.getRetentionCutoff(now, Number.NaN), null);
	assert.equal(helpers.getRetentionCutoff(new Date(Number.NaN), 30), null);
	for (const days of Object.values(helpers.PRUNING_POLICY)) assert.ok(days >= 1);
	// Auto-replies are throttled for 24 hours, so their rows must outlive that window.
	assert.ok(helpers.PRUNING_POLICY.autoReplyDeliveriesDays >= 1);
});

test("pruning stops on a partial batch or when the batch budget is spent", () => {
	assert.equal(helpers.shouldContinuePruning(helpers.PRUNING_BATCH_SIZE, 1), true);
	assert.equal(helpers.shouldContinuePruning(helpers.PRUNING_BATCH_SIZE - 1, 1), false);
	assert.equal(helpers.shouldContinuePruning(helpers.PRUNING_BATCH_SIZE, helpers.PRUNING_MAX_BATCHES_PER_TABLE), false);
});

test("auth guard decisions", () => {
	const session = { user: { role: "user", isPrimaryAdmin: false }, hasMailboxes: true, isSetup: true };
	const base = { mode: "protected", status: "success", session, pathname: "/inbox" };
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, status: "pending" }), { authorized: false, redirect: null });
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, mode: "public", status: "pending" }), {
		authorized: true,
		redirect: null,
	});
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, session: null }), { authorized: false, redirect: "/login" });
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, mode: "public" }), { authorized: true, redirect: "/inbox" });
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, mode: "public", allowAuthenticated: true }), {
		authorized: true,
		redirect: null,
	});
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, requireRole: "admin" }), {
		authorized: false,
		redirect: "/inbox",
	});
	assert.deepEqual(helpers.getAuthGuardDecision(base), { authorized: true, redirect: null });
	const fresh = { user: { role: "admin", isPrimaryAdmin: true }, hasMailboxes: false, isSetup: false };
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, session: fresh, requireMailbox: true }), {
		authorized: false,
		redirect: "/setup",
	});
	assert.deepEqual(helpers.getAuthGuardDecision({ ...base, pathname: "/setup" }), {
		authorized: false,
		redirect: "/inbox",
	});
});

test("only account writes mark the cached session stale", () => {
	assert.equal(helpers.changesCurrentAccount("/api/settings", "PATCH"), true);
	assert.equal(helpers.changesCurrentAccount("/api/mailboxes/abc", "DELETE"), true);
	assert.equal(helpers.changesCurrentAccount("/api/profile/avatar?x=1", "post"), true);
	assert.equal(helpers.changesCurrentAccount("/api/settings", "GET"), false);
	assert.equal(helpers.changesCurrentAccount("/api/settings", undefined), false);
	assert.equal(helpers.changesCurrentAccount("/api/messages/bulk", "POST"), false);
	assert.equal(helpers.changesCurrentAccount("/api/settingsx", "POST"), false);
	assert.equal(helpers.changesCurrentAccount(new URL("http://example.com/api/domains"), "POST"), true);
});
