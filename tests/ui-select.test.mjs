import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-ui-select-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export * from "./src/components/ui/select-utils.ts"; export { createElement, Fragment } from "react";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	createElement: h,
	Fragment,
	readSelectOptions,
	resolveSelectedOption,
	toItemValue,
	fromItemValue,
	longestOptionText,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("native option children are read through arrays, fragments and optgroups", () => {
	const groups = readSelectOptions([
		h("option", { key: "none", value: "" }, "Select domain"),
		[1, 2].map((n) => h("option", { key: n, value: n }, "Domain ", n)),
		false,
		h(Fragment, null, h("option", { value: "x", disabled: true }, "Disabled")),
		h("optgroup", { label: "More", disabled: true }, h("option", { value: "y" }, "In group")),
	]);
	assert.deepEqual(
		groups.map((group) => ({
			label: group.label,
			options: group.options.map(({ value, text, disabled }) => ({ value, text, disabled })),
		})),
		[
			{
				label: null,
				options: [
					{ value: "", text: "Select domain", disabled: false },
					{ value: "1", text: "Domain 1", disabled: false },
					{ value: "2", text: "Domain 2", disabled: false },
					{ value: "x", text: "Disabled", disabled: true },
				],
			},
			{ label: "More", options: [{ value: "y", text: "In group", disabled: true }] },
		],
	);
});

test("an option without a value uses its text, as a native option does", () => {
	const [group] = readSelectOptions(h("option", null, "Plain"));
	assert.equal(group.options[0].value, "Plain");
});

test("the shown option is the matching one, else the first enabled one", () => {
	const groups = readSelectOptions([
		h("option", { key: "a", value: "a", disabled: true }, "A"),
		h("option", { key: "b", value: "b" }, "B"),
		h("option", { key: "c", value: "c" }, "C"),
	]);
	assert.equal(resolveSelectedOption(groups, "c")?.value, "c");
	assert.equal(resolveSelectedOption(groups, "missing")?.value, "b");
	assert.equal(resolveSelectedOption(groups, undefined)?.value, "b");
	assert.equal(resolveSelectedOption([], "a"), null);
});

test("the empty value survives the round trip through Radix, which reserves it", () => {
	assert.notEqual(toItemValue(""), "");
	assert.equal(fromItemValue(toItemValue("")), "");
	assert.equal(fromItemValue(toItemValue("abc")), "abc");
});

test("the trigger is sized by the option with the longest text", () => {
	const [group] = readSelectOptions([
		h("option", { key: "a", value: "0" }, "Off"),
		h("option", { key: "b", value: "20" }, "20 seconds"),
		h("option", { key: "c", value: "5" }, "5 seconds"),
	]);
	assert.equal(longestOptionText(group.options), "20 seconds");
	assert.equal(longestOptionText([]), "");
});
