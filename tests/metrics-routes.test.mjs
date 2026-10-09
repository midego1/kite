import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { listRouteFiles, renderMetricsRoutes, routePath, metricsRoutesPath } from "../scripts/docs-generate.mjs";
import { readFile } from "node:fs/promises";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-metrics-routes-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/metrics-route-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { routeTemplate } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("every route file's template round-trips without raw segments", async () => {
	const mismatches = [];
	for (const file of await listRouteFiles()) {
		const template = routePath(file);
		const concrete = template.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "abc123");
		const got = routeTemplate(concrete);
		if (got !== template || got.includes("abc123")) mismatches.push([concrete, got, template]);
	}
	assert.deepEqual(mismatches, []);
});

test("unknown paths are unmatched and never echoed", () => {
	assert.equal(routeTemplate("/api/does-not-exist/private@example.com"), "unmatched");
	assert.equal(routeTemplate("/"), "unmatched");
	assert.equal(routeTemplate("/api/messages/abc123/unknown/extra"), "unmatched");
});

test("generated route templates are current", async () => {
	assert.equal(await readFile(metricsRoutesPath, "utf8"), await renderMetricsRoutes());
});
