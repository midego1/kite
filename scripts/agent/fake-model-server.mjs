// Standalone fake OpenAI-compatible model for manual validation: node scripts/agent/fake-model-server.mjs --port 3301
// Serves the same scenarios as the Playwright specs (e2e/support/fake-model.ts) and listens on 127.0.0.1 only.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
	options: { port: { type: "string", default: "3301" }, "slow-ms": { type: "string" } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
	console.error(`Invalid --port: ${values.port}`);
	process.exit(1);
}

const parent = join(root, "test-results", "bundles");
mkdirSync(parent, { recursive: true });
const outDir = mkdtempSync(join(parent, "fake-model-"));
const outfile = join(outDir, "fake-model.mjs");
await build({
	entryPoints: [join(root, "e2e/support/fake-model.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { startFakeModel } = await import(pathToFileURL(outfile).href);
rmSync(outDir, { recursive: true, force: true });

const fake = await startFakeModel({ port, slowMs: values["slow-ms"] ? Number(values["slow-ms"]) : undefined });
console.log(`Fake model listening on ${fake.url}`);

const stop = async () => {
	await fake.close();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
