import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-working-hours-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/booking/working-hours-utils.ts")],
	outfile: join(outDir, "working-hours-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { workingHoursOf } = await import(pathToFileURL(join(outDir, "working-hours-utils.mjs")).href);

test("no event type means no working hours", () => {
	assert.equal(workingHoursOf(null), null);
});

test("weekdays, ranges and zone are read from the stored columns", () => {
	assert.deepEqual(
		workingHoursOf({
			weekdays: "[2,4]",
			timeRanges: '[{"startTime":"13:00","endTime":"15:00"}]',
			startTime: "09:00",
			endTime: "17:00",
			timeZone: "America/New_York",
		}),
		{ weekdays: [2, 4], timeRanges: [{ startTime: "13:00", endTime: "15:00" }], timeZone: "America/New_York" },
	);
});

test("malformed JSON falls back to weekdays Monday to Friday and the start and end columns", () => {
	const result = workingHoursOf({
		weekdays: "nope",
		timeRanges: "[]",
		startTime: "08:00",
		endTime: "12:00",
		timeZone: "Not/AZone",
	});
	assert.deepEqual(result.weekdays, [1, 2, 3, 4, 5]);
	assert.deepEqual(result.timeRanges, [{ startTime: "08:00", endTime: "12:00" }]);
	assert.equal(result.timeZone, "UTC");
});

test("out-of-range weekdays and malformed ranges are dropped", () => {
	const result = workingHoursOf({
		weekdays: "[1,9,-1,2.5,3]",
		timeRanges: '[{"startTime":"bad","endTime":"10:00"},{"startTime":"10:00","endTime":"11:00"}]',
		startTime: "09:00",
		endTime: "17:00",
		timeZone: "UTC",
	});
	assert.deepEqual(result.weekdays, [1, 3]);
	assert.deepEqual(result.timeRanges, [{ startTime: "10:00", endTime: "11:00" }]);
});
