import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-compose-drop-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/compose/compose-drop-utils.ts")],
	outfile: join(outDir, "utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { dragHasFiles, namePastedFiles, pastedFiles } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

function clipboard({ types = [], files = [], items, text = "" }) {
	return { types, files, items, getData: (format) => (format === "text/plain" ? text : "") };
}

const png = (name = "image.png") => new File(["x"], name, { type: "image/png" });

test("a drag is a file drag by its types or its items", () => {
	assert.equal(dragHasFiles({ types: ["Files"] }), true);
	assert.equal(dragHasFiles({ types: ["application/x-moz-file", "Files"] }), true);
	assert.equal(dragHasFiles({ types: [], items: [{ kind: "file" }] }), true);
	assert.equal(dragHasFiles({ types: ["text/plain", "text/uri-list"], items: [{ kind: "string" }] }), false);
	assert.equal(dragHasFiles({ types: ["application/x-kite-message-ids"] }), false);
	assert.equal(dragHasFiles(null), false);
});

test("a DOMStringList without includes still counts", () => {
	const list = { length: 1, 0: "Files", item: (index) => ["Files"][index], contains: (value) => value === "Files" };
	assert.equal(dragHasFiles({ types: list }), true);
});

test("files come from the list, or from the file items when a browser fills only those", () => {
	const file = png();
	assert.deepEqual(pastedFiles(clipboard({ files: [file] })), [file]);
	const items = [
		{ kind: "string", getAsFile: () => null },
		{ kind: "file", getAsFile: () => file },
	];
	assert.deepEqual(pastedFiles(clipboard({ items })), [file]);
	assert.deepEqual(pastedFiles(null), []);
});

test("a screenshot, an image without text and a copied file are attached", () => {
	assert.equal(pastedFiles(clipboard({ types: ["Files"], files: [png()] })).length, 1);
	assert.equal(pastedFiles(clipboard({ types: ["text/html", "Files"], files: [png()] })).length, 1);
	// A file copied in a file manager carries its name as text, but no HTML.
	assert.equal(
		pastedFiles(clipboard({ types: ["text/plain", "Files"], files: [png("a.png")], text: "a.png" })).length,
		1,
	);
});

test("a copy with text and a picture of it is a text paste", () => {
	const copied = clipboard({ types: ["text/plain", "text/html", "Files"], files: [png()], text: "Cell A1" });
	assert.deepEqual(pastedFiles(copied), []);
	assert.deepEqual(pastedFiles(clipboard({ types: ["text/plain"], text: "hello" })), []);
});

test("a screenshot gets a dated name in local time, and a second one a counter", () => {
	const now = new Date(2026, 10, 7, 4, 5);
	const [first, second, other] = namePastedFiles([png("image.png"), png(""), png("holiday.png")], now);
	assert.equal(first.name, "screenshot-2026-11-07-0405.png");
	assert.equal(second.name, "screenshot-2026-11-07-0405-2.png");
	assert.equal(first.type, "image/png");
	assert.equal(other.name, "holiday.png");
});

test("the extension follows the file, or the type when the name has none", () => {
	const now = new Date(2026, 0, 2, 23, 59);
	const [jpeg, bare] = namePastedFiles(
		[new File(["x"], "", { type: "image/jpeg" }), new File(["x"], "image", { type: "image/webp" })],
		now,
	);
	assert.equal(jpeg.name, "screenshot-2026-01-02-2359.jpg");
	assert.equal(bare.name, "screenshot-2026-01-02-2359-2.webp");
});

test("files that are not pictures keep their names", () => {
	const [pdf] = namePastedFiles([new File(["x"], "image.pdf", { type: "application/pdf" })]);
	assert.equal(pdf.name, "image.pdf");
});
