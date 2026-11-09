import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-spam-structure-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/spam/analyzers/structure.ts")],
	outfile: join(bundleDirectory, "structure.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { analyzeStructure } = await import(pathToFileURL(join(bundleDirectory, "structure.mjs")).href);

function replyToMismatch(from, replyTo) {
	const message = { fromAddr: from, subject: "Hello", text: "A normal message body.", html: null };
	const prepared = { visibleText: "A normal message body." };
	return analyzeStructure(message, { "Reply-To": replyTo }, prepared).some(
		(signal) => signal.id === "reply_to_mismatch",
	);
}

test("a Reply-To on another registrable domain is a mismatch", () => {
	assert.equal(replyToMismatch("News <news@example.com>", "replies@other-example.com"), true);
	assert.equal(replyToMismatch("News <news@example.com>", "replies@example.net"), true);
});

test("a Reply-To on the sender's domain or one of its subdomains is not", () => {
	assert.equal(replyToMismatch("News <news@example.com>", "replies@example.com"), false);
	assert.equal(replyToMismatch("News <news@example.com>", "x@reply.example.com"), false);
	assert.equal(replyToMismatch("News <news@mail.example.co.uk>", "x@support.example.co.uk"), false);
});

test("sibling tenants of a shared suffix stay apart", () => {
	assert.equal(replyToMismatch("News <news@a.github.io>", "x@b.github.io"), true);
});
