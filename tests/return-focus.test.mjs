import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-return-focus-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/ui/use-return-focus-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { pickOpener } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const body = "body";

test("an explicit opener wins, as the phone menu button does for its sheet", () => {
	assert.equal(pickOpener({ explicit: "menu", focused: "search", body, pressed: null, now: 0 }), "menu");
});

test("otherwise the element that had focus when the dialog opened", () => {
	assert.equal(pickOpener({ explicit: null, focused: "search", body, pressed: null, now: 0 }), "search");
});

test("with only <body> focused (Safari after a click) the button pressed just before", () => {
	const pressed = { element: "palette-button", at: 1000 };
	assert.equal(pickOpener({ explicit: null, focused: body, body, pressed, now: 1500 }), "palette-button");
	assert.equal(pickOpener({ explicit: null, focused: body, body, pressed, now: 5000 }), null);
	assert.equal(pickOpener({ explicit: null, focused: null, body, pressed: null, now: 0 }), null);
});
