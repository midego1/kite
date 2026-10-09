import assert from "node:assert/strict";
import test from "node:test";
import { findTodoMarkers, isScannedFile } from "../scripts/quality/todo-utils.mjs";

const T = "TO" + "DO";
const F = "FIX" + "ME";
const H = "HA" + "CK";

test("unlinked markers have a null issue", () => {
	assert.deepEqual(findTodoMarkers(`// ${T} fix later`, "a.ts"), [{ file: "a.ts", line: 1, marker: T, issue: null }]);
	assert.equal(findTodoMarkers(`// ${F}`, "a.ts")[0].issue, null);
	assert.equal(findTodoMarkers(`# ${H}: x`, "a.ts")[0].issue, null);
});

test("linked markers carry their issue number", () => {
	const found = findTodoMarkers(`${F}(#7)\n${H}(#8)\n${T}(#9)`, "a.ts");
	assert.deepEqual(
		found.map((m) => [m.marker, m.issue]),
		[
			[F, 7],
			[H, 8],
			[T, 9],
		],
	);
});

test("lower-case and mixed-case words are ignored", () => {
	assert.deepEqual(findTodoMarkers("Todo todo fixme hack Hack", "a.ts"), []);
});

test("longer words are ignored", () => {
	assert.deepEqual(findTodoMarkers(`${T}S ${T}LIST HACKS ${F}D`, "a.ts"), []);
});

test("a space or malformed link is unlinked", () => {
	assert.equal(findTodoMarkers(`${T} (#1)`, "a.ts")[0].issue, null);
	assert.equal(findTodoMarkers(`${T}(#)`, "a.ts")[0].issue, null);
});

test("line numbers are 1-based and handle CRLF and repeats", () => {
	const found = findTodoMarkers(`a\r\n${T}(#1) ${F}\r\nb`, "a.ts");
	assert.deepEqual(
		found.map((m) => [m.line, m.issue]),
		[
			[2, 1],
			[2, null],
		],
	);
});

test("excluded and binary files are not scanned", () => {
	assert.equal(isScannedFile("package-lock.json"), false);
	assert.equal(isScannedFile("deploy/x/package-lock.json"), false);
	assert.equal(isScannedFile("cloudflare-env.d.ts"), false);
	assert.equal(isScannedFile("docs/quality.md"), false);
	assert.equal(isScannedFile("public/logo.PNG"), false);
	assert.equal(isScannedFile("a.bin", "ab\0cd"), false);
	assert.equal(isScannedFile("src/a.ts", "text"), true);
});

test("the utility file does not match itself", async () => {
	const fs = await import("node:fs/promises");
	const source = await fs.readFile(new URL("../scripts/quality/todo-utils.mjs", import.meta.url), "utf8");
	assert.deepEqual(findTodoMarkers(source, "todo-utils.mjs"), []);
});
