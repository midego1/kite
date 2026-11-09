import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-row-long-press-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/use-row-long-press-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { shouldCancelLongPress, LONG_PRESS_MS } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a still finger does not cancel the press", () => {
	assert.equal(shouldCancelLongPress({ x: 10, y: 10 }, { x: 10, y: 10 }), false);
	assert.equal(shouldCancelLongPress({ x: 10, y: 10 }, { x: 14, y: 12 }), false);
});

test("a finger that moves past the tolerance, in either axis, cancels the press", () => {
	assert.equal(shouldCancelLongPress({ x: 0, y: 0 }, { x: 11, y: 0 }), true);
	assert.equal(shouldCancelLongPress({ x: 0, y: 0 }, { x: 0, y: -11 }), true);
});

test("the cancel point matches SwipeableRow's own drag threshold exactly, so a real swipe always cancels", () => {
	// SwipeableRow treats this same 10px as already a drag (`Math.abs(dx) < INTENT_DISTANCE` is the only escape),
	// so the long press must give up here too: once it captures the pointer, this hook sees nothing more.
	assert.equal(shouldCancelLongPress({ x: 0, y: 0 }, { x: 10, y: 0 }), true);
});

test("the hold is long enough to tell apart from a tap, short enough to still feel immediate", () => {
	assert.ok(LONG_PRESS_MS >= 400 && LONG_PRESS_MS <= 600);
});
