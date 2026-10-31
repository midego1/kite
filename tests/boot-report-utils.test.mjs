import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-boot-report-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/boot/report-utils.ts")],
	outfile: join(bundleDirectory, "report.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { parseBootFreezeReport, readBootReportBody } = await import(
	pathToFileURL(join(bundleDirectory, "report.mjs")).href
);

/** The report size limit in report-utils.ts. */
const BOOT_REPORT_MAX_BYTES = 2_048;

const report = {
	page: "/inbox",
	phase: "children-rendering",
	afterMs: 612.4,
	visibleMs: 500,
	step: "reading-pane",
	build: "2026.10.31.7 (9b00167)",
	afterUpdate: true,
};

test("a report from the boot trace is read with whole milliseconds", () => {
	assert.deepEqual(parseBootFreezeReport(JSON.stringify(report)), { ...report, afterMs: 612 });
	// Step, build and the update are optional; the root page has an empty first segment.
	assert.deepEqual(
		parseBootFreezeReport(JSON.stringify({ page: "", phase: "loader-mounted", afterMs: 0, visibleMs: 0 })),
		{ page: "/", phase: "loader-mounted", step: null, afterMs: 0, visibleMs: 0, build: null, afterUpdate: false },
	);
});

test("anything that is not a report is refused, free text included", () => {
	const refused = [
		"not json",
		"null",
		"[]",
		JSON.stringify({ ...report, phase: "Phase With Spaces" }),
		JSON.stringify({ ...report, phase: undefined }),
		JSON.stringify({ ...report, step: "someone@example.com" }),
		JSON.stringify({ ...report, page: "/inbox/msg_123/more" }),
		JSON.stringify({ ...report, page: "https://elsewhere.example" }),
		JSON.stringify({ ...report, build: "<script>" }),
		JSON.stringify({ ...report, afterMs: -1 }),
		JSON.stringify({ ...report, visibleMs: "500" }),
		JSON.stringify({ ...report, afterMs: 1e12 }),
		JSON.stringify({ ...report, build: "x".repeat(BOOT_REPORT_MAX_BYTES) }),
	];
	for (const text of refused) assert.equal(parseBootFreezeReport(text), null, text.slice(0, 80));
});

test("the body is read up to the limit whatever Content-Length says, and a longer one is refused unread", async () => {
	const post = (body) => new Request("https://mail.example.com/api/boot-report", { method: "POST", body });
	assert.equal(await readBootReportBody(post(JSON.stringify(report))), JSON.stringify(report));
	assert.equal(await readBootReportBody(new Request("https://mail.example.com/api/boot-report")), "");
	assert.equal(
		await readBootReportBody(post("é".repeat(BOOT_REPORT_MAX_BYTES / 2))),
		"é".repeat(BOOT_REPORT_MAX_BYTES / 2),
	);
	assert.equal(await readBootReportBody(post("x".repeat(BOOT_REPORT_MAX_BYTES + 1))), null);
	// A stream that never ends is cancelled once it passes the limit.
	let cancelled = false;
	const endless = new ReadableStream({
		pull(controller) {
			controller.enqueue(new Uint8Array(512));
		},
		cancel() {
			cancelled = true;
		},
	});
	const streamed = new Request("https://mail.example.com/api/boot-report", {
		method: "POST",
		body: endless,
		duplex: "half",
	});
	assert.equal(await readBootReportBody(streamed), null);
	assert.equal(cancelled, true);
});
