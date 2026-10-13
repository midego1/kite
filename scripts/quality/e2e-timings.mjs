// Refreshes e2e/timings.json from Playwright JSON reports, for example the
// `test-results/playwright-results.json` in each CI "e2e-evidence-shard-N" artifact:
//   npm run e2e:timings -- shard-*/test-results/playwright-results.json
// Entries for tests that are not in the given reports are kept, so a partial refresh never loses data.
import fs from "node:fs/promises";
import { timingsFromReports } from "./e2e-shard-utils.mjs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass one or more playwright-results.json files");
const reports = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
const existing = JSON.parse(await fs.readFile("e2e/timings.json", "utf8").catch(() => "{}"));
const merged = { ...existing, ...timingsFromReports(reports) };
const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
await fs.writeFile("e2e/timings.json", `${JSON.stringify(sorted, null, "\t")}\n`);
console.log(`e2e/timings.json: ${Object.keys(sorted).length} tests`);
