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

process.stdout.write(
	renderSummary({
		timings: await readJson("quality/timings.json"),
		playwright: await readJson("playwright-results.json"),
		coverage: await readJson("coverage/summary.json"),
	}),
);
