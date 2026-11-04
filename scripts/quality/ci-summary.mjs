import fs from "node:fs/promises";
import path from "node:path";
import { renderSummary } from "./ci-summary-utils.mjs";

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag > 0 ? process.argv[dirFlag + 1] : "test-results";

async function readJson(relative) {
	try {
		return JSON.parse(await fs.readFile(path.join(dir, relative), "utf8"));
	} catch {
		return null;
	}
}

const entries = await fs.readdir(dir).catch(() => []);
const sliceNumbers = entries.flatMap((entry) => /^slice-(\d+)$/.exec(entry)?.[1] ?? []).map(Number);
const slices = await Promise.all(
	sliceNumbers
		.sort((a, b) => a - b)
		.map(async (slice) => ({ slice, report: await readJson(`slice-${slice}/playwright-results.json`) })),
);

process.stdout.write(
	renderSummary({
		timings: await readJson("quality/timings.json"),
		playwright: await readJson("playwright-results.json"),
		slices,
		coverage: await readJson("coverage/summary.json"),
	}),
);
