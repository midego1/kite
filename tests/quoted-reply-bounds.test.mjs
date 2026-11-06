import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Reply parsing runs on every stored message and again in the reader. The large cases run in a child process with a
// 128 MB heap, so a bound that stops working shows up as a failed child instead of slowing the whole test run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-quoted-reply-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { buildSnippet, parseRawMime } from "${root}/src/lib/email/parse";
export { getLatestEmailContent, splitRepliedEmailContent } from "${root}/src/lib/email/reply-content-utils";
`,
);
const bundle = join(directory, "entry.mjs");
await build({
	entryPoints: [entry],
	outfile: bundle,
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { buildSnippet, getLatestEmailContent, splitRepliedEmailContent } = await import(pathToFileURL(bundle).href);
const MAX_QUOTE_DEPTH = 32;

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { buildSnippet, parseRawMime, splitRepliedEmailContent } from ${JSON.stringify(pathToFileURL(bundle).href)};

const header = "From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/plain\\r\\n\\r\\n";
const repeated = (line, count) => (line + "\\r\\n").repeat(count);
const lines = 149_000;
const shapes = {
	shortChain: () => repeated("> On a wrote:", 2_000),
	quotedWrote: () => repeated("> On a wrote:", lines),
	wrote: () => repeated("On Mon wrote:", lines),
	original: () => repeated("-----Original Message-----", lines),
	quotedOriginal: () => repeated("> -----Original Message-----", lines),
	separator: () => repeated("__________", lines),
	quotedSeparator: () => repeated("> __________", lines),
	mixedDepth: () => Array.from({ length: lines }, (_, index) => ">".repeat(index % 50) + " x").join("\\r\\n"),
	spacedLine: () => "On" + " ".repeat(8_000_000) + "x\\r\\n",
	bracketLine: () => "On " + ", <".repeat(2_000_000) + " wrote:\\r\\n",
	headerLine: () => "-----Original Message-----\\r\\nFrom:" + " ".repeat(8_000_000) + "x\\u2028y\\r\\n",
};

const out = {};
for (const [name, body] of Object.entries(shapes)) {
	const started = performance.now();
	const raw = new TextEncoder().encode(header + body()).buffer;
	const parsed = await parseRawMime(raw);
	const snippet = buildSnippet(parsed.text, parsed.html);
	const parts = splitRepliedEmailContent(parsed.text, { ownAddress: "b@example.com" });
	out[name] = { snippet: snippet.length, split: typeof parts.latestContent, ms: Math.round(performance.now() - started) };
}
console.log(JSON.stringify(out));
`,
);

// Without coverage collection, which every child would inherit and which would have to fit in the same heap.
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => name !== "NODE_V8_COVERAGE" && name !== "NODE_TEST_CONTEXT"),
);

test("large reply chains are split within a 128 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=128", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 120_000,
	});
	const results = JSON.parse(output);
	for (const [name, result] of Object.entries(results)) {
		assert.equal(result.split, "string", name);
		assert.ok(result.ms < 20_000, `${name}: ${result.ms} ms`);
	}
	assert.equal(Object.keys(results).length, 11);
});

/** A chain of `levels` "On … wrote:" replies, each quoted once more than the reply before it. */
function replyChain(levels) {
	return Array.from({ length: levels }, (_, level) => {
		const prefix = "> ".repeat(level);
		return `${prefix}Reply ${level}\n${prefix}\n${prefix}On Mon, Jan ${(level % 28) + 1}, 2024 at 10:00 AM Ann <ann@example.com> wrote:`;
	})
		.concat(`${"> ".repeat(levels)}First message`)
		.join("\n");
}

/** The quotes of `parts`, outermost first. */
function quoteLevels(parts) {
	const levels = [];
	for (let quote = parts.quotedContent[0]; quote; quote = quote.quotedContent[0]) levels.push(quote);
	return levels;
}

test("an ordinary thread keeps its nested quotes", () => {
	assert.deepEqual(splitRepliedEmailContent(replyChain(4), { ownAddress: "ann@example.com" }), {
		latestContent: "Reply 0",
		quotedContent: [
			{
				dateLine: "Mon, Jan 1",
				direction: "sent",
				content: "Reply 1",
				quotedContent: [
					{
						dateLine: "Mon, Jan 2",
						direction: "sent",
						content: "Reply 2",
						quotedContent: [
							{
								dateLine: "Mon, Jan 3",
								direction: "sent",
								content: "Reply 3",
								quotedContent: [
									{
										dateLine: "Mon, Jan 4",
										direction: "sent",
										content: "First message",
										quotedContent: [],
									},
								],
							},
						],
					},
				],
			},
		],
	});
});

test("a thread at the quote depth keeps every level", () => {
	const levels = quoteLevels(splitRepliedEmailContent(replyChain(MAX_QUOTE_DEPTH)));
	assert.equal(levels.length, MAX_QUOTE_DEPTH);
	assert.equal(levels.at(-1).content, "First message");
	assert.equal(levels.at(-2).content, `Reply ${MAX_QUOTE_DEPTH - 1}`);
});

test("text past the quote depth stays in the deepest quote", () => {
	const levels = quoteLevels(splitRepliedEmailContent(replyChain(MAX_QUOTE_DEPTH + 3)));
	assert.equal(levels.length, MAX_QUOTE_DEPTH);
	const deepest = levels.at(-1);
	assert.deepEqual(deepest.quotedContent, []);
	assert.match(deepest.content, new RegExp(`^Reply ${MAX_QUOTE_DEPTH}\\n`));
	assert.match(deepest.content, /First message$/);
});

test("the latest content does not depend on the depth of the quotes", () => {
	assert.equal(getLatestEmailContent(replyChain(2_000)), "Reply 0");
	assert.equal(getLatestEmailContent("Only text\n\n"), "Only text");
	assert.equal(getLatestEmailContent(null), "");
});

test("the snippet collapses whitespace and stops at its length", () => {
	assert.equal(buildSnippet("  one\n\ntwo\t three  ", null), "one two three");
	assert.equal(buildSnippet("one two three", null, 5), "one t");
	assert.equal(buildSnippet("one two three", null, 4), "one ");
	assert.equal(buildSnippet("one\n\nOn Mon wrote:\n> two", null), "one");
	assert.equal(buildSnippet(null, "<p>one</p><p>two</p>"), "one two");
	assert.equal(buildSnippet(" \n ", null), "");
	assert.equal(buildSnippet("a ".repeat(500), null), "a ".repeat(100));
});

test("markers keep their priority and details", () => {
	const outlook =
		"Hello\n> quoted first\n-----Original Message-----\nFrom: Bob <bob@example.com>\nSent: Monday\n\nBody";
	assert.deepEqual(splitRepliedEmailContent(outlook), {
		latestContent: "Hello\n> quoted first",
		quotedContent: [{ dateLine: "Monday", direction: "received", content: "Body", quotedContent: [] }],
	});
	const separated = "Hello\n__________\nFrom: Bob <me@example.com>\nDate: Tuesday\nBody";
	assert.deepEqual(splitRepliedEmailContent(separated, { ownAddress: "me@example.com" }), {
		latestContent: "Hello",
		quotedContent: [
			{
				dateLine: "Tuesday",
				direction: "sent",
				content: "From: Bob <me@example.com>\nDate: Tuesday\nBody",
				quotedContent: [],
			},
		],
	});
	assert.equal(splitRepliedEmailContent("On   wrote:\nx").quotedContent[0].dateLine, "Unknown time");
	assert.equal(splitRepliedEmailContent("  ON  a day  WROTE:  \nx").quotedContent[0].dateLine, "a day");
	assert.equal(splitRepliedEmailContent("On  wrote:\nx").quotedContent.length, 0);
});

test("a marker line far longer than any real one is plain text", () => {
	const line = `On ${"x".repeat(2_000)} wrote:`;
	assert.deepEqual(splitRepliedEmailContent(`${line}\nBody`), { latestContent: `${line}\nBody`, quotedContent: [] });
});
