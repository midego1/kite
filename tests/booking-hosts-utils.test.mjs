import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-booking-hosts-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "hosts-utils.mjs");
const result = await build({
	entryPoints: [join(root, "src/lib/booking/hosts-utils.ts")],
	outfile,
	bundle: true,
	metafile: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseBookingHostIds } = await import(pathToFileURL(outfile).href);

test("hosts-utils stays free of the database layer", () => {
	const inputs = Object.keys(result.metafile.inputs);
	assert.deepEqual(inputs, ["src/lib/booking/hosts-utils.ts"]);
});

test("the owner always leads the host list", () => {
	assert.deepEqual(parseBookingHostIds('["b","a"]', "a"), ["a", "b"]);
	assert.deepEqual(parseBookingHostIds('["b","c"]', "a"), ["a", "b", "c"]);
});

test("older or malformed values fall back to the owner alone", () => {
	for (const value of ["", "[]", "not json", '{"a":1}', '["a","a"]', '["a",""]', '["a",1]', "null"]) {
		assert.deepEqual(parseBookingHostIds(value, "owner"), ["owner"], value);
	}
});
