import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// A text part beside an HTML part is rendered in both formats. The large cases run in a child process with a 128 MB
// heap, so a bound that stops working shows up as a failed child instead of slowing the whole test run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mixed-body-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { buildSnippet, parseRawMime } from "${root}/src/lib/email/parse";
export { conversionCost, MAX_BODY_CONVERSION_COST } from "${root}/src/lib/email/mime-body-utils";
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
const { conversionCost, MAX_BODY_CONVERSION_COST, parseRawMime } = await import(pathToFileURL(bundle).href);

const messageHelpers = `
const header = "From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\n";
const multipart = (kind, parts) =>
	header + 'Content-Type: multipart/' + kind + '; boundary="B"\\r\\n\\r\\n' +
	parts.map((part) => "--B\\r\\n" + part + "\\r\\n").join("") + "--B--\\r\\n";
const mixed = (...parts) => multipart("mixed", parts);
const alternative = (...parts) => multipart("alternative", parts);
const text = (body) => "Content-Type: text/plain\\r\\n\\r\\n" + body;
const html = (body) => "Content-Type: text/html\\r\\n\\r\\n" + body;
const lines = (line, count) => (line + "\\r\\n").repeat(count);
const encode = (message) => new TextEncoder().encode(message).buffer;
`;

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { buildSnippet, parseRawMime } from ${JSON.stringify(pathToFileURL(bundle).href)};
${messageHelpers}
const hello = html("<p>hi</p>");
const shapes = {
	brackets: () => mixed(hello, text(lines("<".repeat(52), 149_000))),
	longBrackets: () => mixed(hello, text(lines("<".repeat(200), 39_000))),
	largeBrackets: () => mixed(hello, text(lines("<".repeat(600), 39_000))),
	links: () => mixed(hello, text(lines("http://a.b/ ".repeat(13), 149_000))),
	longLinks: () => mixed(hello, text(lines("http://a.b/ ".repeat(50), 39_000))),
	htmlBrackets: () => mixed(text("hi"), html(lines("<".repeat(158), 149_000))),
	longHtmlBrackets: () => mixed(text("hi"), html(lines("<".repeat(600), 39_000))),
	plainBesideHtml: () => mixed(html(lines("a".repeat(160), 37_000)), text(lines("b".repeat(160), 37_000))),
	alternativeBrackets: () => alternative(text(lines("<".repeat(52), 149_000)), hello),
	underLimit: () => mixed(hello, text("x".repeat(15_900_000))),
};

const out = {};
for (const [name, message] of Object.entries(shapes)) {
	const started = performance.now();
	const parsed = await parseRawMime(encode(message()));
	const snippet = buildSnippet(parsed.text, parsed.html);
	out[name] = {
		text: parsed.text?.length ?? 0,
		html: parsed.html?.length ?? 0,
		snippet: snippet.length,
		ms: Math.round(performance.now() - started),
	};
}
console.log(JSON.stringify(out));
`,
);

// Without coverage collection, which every child would inherit and which would have to fit in the same heap.
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => name !== "NODE_V8_COVERAGE" && name !== "NODE_TEST_CONTEXT"),
);

test("large text and HTML parts are rendered within a 128 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=128", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 300_000,
	});
	const results = JSON.parse(output);
	assert.equal(Object.keys(results).length, 10);
	for (const [name, result] of Object.entries(results)) assert.ok(result.ms < 60_000, `${name}: ${result.ms} ms`);
	// Over the limit: the parts keep to their own format.
	assert.equal(results.brackets.html, "<p>hi</p>".length);
	assert.equal(results.links.html, "<p>hi</p>".length);
	assert.equal(results.htmlBrackets.text, 2);
	// Under it: both bodies hold both parts.
	assert.ok(results.plainBesideHtml.text > 11_800_000);
	assert.ok(results.plainBesideHtml.html > 11_800_000);
	assert.ok(results.underLimit.html > 15_900_000);
	// multipart/alternative renders one representation of each format, as before.
	assert.equal(results.alternativeBrackets.html, "<p>hi</p>".length);
	assert.equal(results.alternativeBrackets.text, 149_000 * 53);
});

const parts = new Function(`${messageHelpers}return { alternative, encode, html, mixed, text };`)();

test("text and HTML parts stay in order and in both bodies under the limit", async () => {
	const parsed = await parseRawMime(
		parts.encode(parts.mixed(parts.html("<p>one</p>"), parts.text("two <3"), parts.html("<p>three</p>"))),
	);
	assert.match(parsed.html, /<p>one<\/p>[^]*two &lt;3[^]*<p>three<\/p>/);
	assert.match(parsed.text, /one[^]*two <3[^]*three/);
});

test("over the limit each format holds only its own parts, in order", async () => {
	const large = "x".repeat(MAX_BODY_CONVERSION_COST + 1);
	const parsed = await parseRawMime(
		parts.encode(
			parts.mixed(parts.html("<p>one</p>"), parts.text(large), parts.html("<p>three</p>"), parts.text("four")),
		),
	);
	assert.equal(parsed.html, "<p>one</p>\n<p>three</p>");
	assert.equal(parsed.text.length, large.length + "\nfour".length);
	assert.ok(parsed.text.endsWith("x\nfour"));
});

test("a body in one format is never affected by the limit", async () => {
	const large = "<".repeat(MAX_BODY_CONVERSION_COST);
	const parsed = await parseRawMime(parts.encode(parts.mixed(parts.text(large), parts.text("two"))));
	assert.equal(parsed.html, null);
	assert.ok(parsed.text.endsWith("<\ntwo"));
});

test("parts inside multipart/alternative do not count toward the limit", async () => {
	const large = "<".repeat(MAX_BODY_CONVERSION_COST);
	const parsed = await parseRawMime(parts.encode(parts.alternative(parts.text(large), parts.html("<p>one</p>"))));
	assert.equal(parsed.html, "<p>one</p>");
	assert.equal(parsed.text.length, large.length);
});

test("characters that get replaced cost more than others", () => {
	assert.equal(conversionCost("abc"), 3);
	assert.equal(conversionCost("<a>"), 19);
	assert.equal(conversionCost("\"'?&\n"), 45);
	assert.equal(conversionCost(""), 0);
});
