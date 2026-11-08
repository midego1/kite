import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-message-shortcuts-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/message-actions/message-shortcuts.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { reachableMessageShortcuts } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const shortcuts = [{ key: "e" }, { key: "y" }, { key: "#" }, { key: "r" }, { key: "a" }, { key: "f" }, { key: "u" }];

test("with nothing checked in the list, every reader shortcut stays reachable", () => {
	assert.equal(reachableMessageShortcuts(shortcuts, 0), shortcuts);
});

test("with rows checked in the list, archive (e/y) and trash (#) belong to that selection instead", () => {
	const reachable = reachableMessageShortcuts(shortcuts, 1);
	assert.deepEqual(
		reachable.map((shortcut) => shortcut.key),
		["r", "a", "f", "u"],
	);
});
