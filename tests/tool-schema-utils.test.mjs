import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodSchema } from "ai";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-tool-schema-utils-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/agent/tool-schema-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	logLevel: "silent",
});
const { toolEmailSchema } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("toolEmailSchema accepts one valid address and rejects anything else", () => {
	for (const value of ["owner@example.com", "first.last+tag@mail.example.org"]) {
		assert.equal(toolEmailSchema.safeParse(value).success, true, value);
	}
	for (const value of [
		"",
		"not-an-email",
		"a..b@example.com",
		".lead@example.com",
		"two@example.com, more@example.com",
	]) {
		const result = toolEmailSchema.safeParse(value);
		assert.equal(result.success, false, value);
		assert.equal(result.error.issues[0].message, "Invalid email address");
	}
});

test("toolEmailSchema is written to JSON Schema as an email string without a pattern", () => {
	const json = zodSchema(toolEmailSchema).jsonSchema;
	assert.equal(json.type, "string");
	assert.equal(json.format, "email");
	assert.equal(json.description, "A single email address");
	assert.equal("pattern" in json, false);
});
