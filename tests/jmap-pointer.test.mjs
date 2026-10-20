import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-jmap-pointer-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/jmap/pointer-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { unescapePointerToken } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("an escaped mailbox role ref decodes to the id Kite stores", () => {
	assert.equal(unescapePointerToken("mbx_x~0trash"), "mbx_x~trash");
	assert.equal(unescapePointerToken("mbx_x~0f~0fld_1"), "mbx_x~f~fld_1");
});

test("~1 decodes to a slash and an unescaped token is unchanged", () => {
	assert.equal(unescapePointerToken("a~1b"), "a/b");
	assert.equal(unescapePointerToken("$flagged"), "$flagged");
});

test("~01 decodes to ~1, not to a slash (RFC 6901 §4 order)", () => {
	assert.equal(unescapePointerToken("~01"), "~1");
});
