import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Admin → Storage → Attachment storage: what the card says and which buttons it offers.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-attachment-storage-card-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/app/(admin)/storage/attachment-storage-utils.ts";`,
		resolveDir: root,
		sourcefile: "attachment-storage-card-entry.ts",
	},
	outfile: join(bundleDirectory, "card.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const card = await import(pathToFileURL(join(bundleDirectory, "card.mjs")).href);

const job = (fields = {}) => ({
	id: "asj_1",
	direction: "reclaim",
	status: "running",
	phase: "reclaim",
	total: 10,
	done: 4,
	converted: 3,
	unshared: 0,
	unmatched: 1,
	failed: 0,
	startedAt: "2026-10-31T10:00:00.000Z",
	finishedAt: null,
	lastError: null,
	stopReason: null,
	...fields,
});

const report = (fields = {}) => ({
	objects: { rows: 5, keys: 4, bytes: 5000, storedBytes: 4000 },
	raw: { rows: 2, bytes: 2048 },
	shared: { keys: 1, rows: 1 },
	reclaim: { pending: { rows: 3, bytes: 3072 }, unmatched: { rows: 1 } },
	job: null,
	jobsReady: true,
	switches: { rawIndex: true, sharing: true },
	...fields,
});

test("headlines name the job and its state", () => {
	assert.equal(card.jobHeadline(job()), "Reclaiming space");
	assert.equal(card.jobHeadline(job({ direction: "materialize", phase: "materialize" })), "Restoring separate copies");
	assert.equal(
		card.jobHeadline(job({ direction: "materialize", phase: "unshare" })),
		"Giving shared files their own copy",
	);
	assert.equal(card.jobHeadline(job({ status: "interrupted" })), "Reclaim stopped part way");
	assert.equal(card.jobHeadline(job({ status: "failed" })), "Reclaim stopped after repeated errors");
	assert.equal(card.jobHeadline(job({ status: "cancelled" })), "Reclaim cancelled");
	assert.match(card.jobHeadline(job({ status: "cancelled", stopReason: "raw_index_off" })), /ATTACHMENT_RAW_INDEX/);
	assert.equal(card.jobHeadline(job({ status: "completed" })), "Space reclaimed");
	assert.equal(card.jobHeadline(job({ direction: "materialize", status: "completed" })), "Separate copies restored");
});

test("progress and summaries count files", () => {
	assert.deepEqual(card.jobProgress(job()), { done: 4, total: 10, percent: 40 });
	assert.deepEqual(card.jobProgress(job({ total: 0, done: 0 })), { done: 0, total: 0, percent: 100 });
	assert.deepEqual(card.jobProgress(job({ total: 2, done: 3 })).total, 3, "never more done than counted");
	assert.equal(card.jobSummary(job()), "3 files now served from the raw message, 1 file kept a separate copy.");
	assert.equal(
		card.jobSummary(job({ direction: "materialize", converted: 1, unshared: 2, unmatched: 0, failed: 1 })),
		"1 file copied out of the raw message, 2 files no longer shared, 1 file could not be processed.",
	);
	assert.equal(card.jobSummary(job({ converted: 0, unmatched: 0 })), "Nothing needed to change.");
});

test("buttons follow the counts, the switches and the running job", () => {
	assert.ok(card.canReclaim(report()) && card.canMaterialize(report()));
	assert.ok(!card.canReclaim(report({ switches: { rawIndex: false, sharing: true } })));
	assert.ok(!card.canReclaim(report({ reclaim: { pending: { rows: 0, bytes: 0 }, unmatched: { rows: 0 } } })));
	assert.ok(!card.canMaterialize(report({ raw: { rows: 0, bytes: 0 }, shared: { keys: 0, rows: 0 } })));
	assert.ok(!card.canReclaim(report({ jobsReady: false })) && !card.canMaterialize(report({ jobsReady: false })));
	assert.ok(!card.canReclaim(report({ job: job() })) && !card.canMaterialize(report({ job: job() })));
	// An interrupted job can always be resumed, even when the counts say nothing is left of its kind.
	const nothing = { raw: { rows: 0, bytes: 0 }, shared: { keys: 0, rows: 0 }, reclaim: null };
	assert.ok(card.canMaterialize(report({ ...nothing, job: job({ direction: "materialize", status: "interrupted" }) })));
	assert.ok(card.canReclaim(report({ ...nothing, job: job({ status: "interrupted" }) })));
	assert.equal(card.resumableDirection(job({ status: "interrupted" })), "reclaim");
	assert.equal(card.resumableDirection(job()), null);
	assert.equal(card.resumableDirection(null), null);
	assert.ok(card.isJobRunning(job()) && !card.isJobRunning(null));
});

test("restoring copies warns while a switch would keep sharing or raw-backing new mail", () => {
	assert.match(
		card.materializeWarning({ sharing: true, rawIndex: true }),
		/^ATTACHMENT_SHARING and ATTACHMENT_RAW_INDEX are still on/,
	);
	assert.match(card.materializeWarning({ sharing: false, rawIndex: true }), /^ATTACHMENT_RAW_INDEX is still on/);
	assert.match(card.materializeWarning({ sharing: true, rawIndex: false }), /^ATTACHMENT_SHARING is still on/);
	assert.equal(card.materializeWarning({ sharing: false, rawIndex: false }), null);
});

test("the stats and the rollback link", () => {
	const stats = card.attachmentStorageStats(report());
	assert.deepEqual(
		stats.map((stat) => [stat.label, stat.value]),
		[
			["Own copy", "5"],
			["From the raw message", "2"],
			["Shared copies", "1"],
			["Can be reclaimed", "3"],
		],
	);
	assert.equal(stats[2].hint, "of 1 file");
	assert.equal(card.attachmentStorageStats(report({ shared: { keys: 0, rows: 0 } }))[2].hint, "None");
	assert.equal(card.attachmentStorageStats(report({ reclaim: null }))[3].hint, "After the database update");
	assert.match(card.ATTACHMENT_ROLLBACK_URL, /recovery\.md#materialize-then-roll-back$/);
});
