import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

/*
 * Hostile stored mail must not freeze the reader, the list or the inbound queue: each helper here used a regex that
 * retried from every character of a long run (`X+$`, `<([^>]+)>$`), which took seconds at 100,000 characters. They
 * are linear now. The budgets are generous (the old code took 5 to 12 seconds on these inputs) so a slow runner
 * does not fail them; the results are checked too.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-hostile-input-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { findLinks } from "./src/lib/email/linkify-utils.ts";
			export { parseAddress } from "./src/lib/utils.ts";
			export { htmlToPlainText } from "./src/components/compose/rich-text-utils.ts";
			export { assessAttachmentRisk, hasDecoyExtension, isExecutableFilename } from "./src/lib/email/attachment-risk.ts";
			export { truncateUtf8 } from "./src/lib/email/inbound-limits.ts";
			export { parseCssColour } from "./src/components/messages/email-colour-utils.ts";
			export { getThreadParticipants } from "./src/components/messages/conversation-thread-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "hostile-input-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const {
	findLinks,
	parseAddress,
	htmlToPlainText,
	assessAttachmentRisk,
	hasDecoyExtension,
	isExecutableFilename,
	truncateUtf8,
	parseCssColour,
	getThreadParticipants,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const BUDGET_MS = 250;

function timed(run) {
	const started = performance.now();
	const result = run();
	return { result, ms: performance.now() - started };
}

test("email addresses after a long run of dashes are found in linear time", () => {
	const chunk = `a${"-".repeat(2_030)}a@b.cc `;
	const { result, ms } = timed(() => findLinks(chunk.repeat(200)));
	assert.ok(ms < BUDGET_MS, `${ms} ms`);
	assert.equal(result.length, 200);
	assert.equal(result[0].kind, "email");
	// Trailing punctuation still leaves the address.
	assert.deepEqual(
		findLinks("Mail me at ann@example.com.-_ today").map((link) => link.text),
		["ann@example.com"],
	);
});

test("an address in angle brackets is parsed by index, as the regex did", () => {
	assert.deepEqual(parseAddress("Ann <Ann@Example.com>"), { local: "ann", domain: "example.com" });
	assert.deepEqual(parseAddress("<a@b.c>"), { local: "a", domain: "b.c" });
	assert.deepEqual(parseAddress("x <y> <a@b.c>"), { local: "a", domain: "b.c" });
	assert.deepEqual(parseAddress("a@b.c"), { local: "a", domain: "b.c" });
	assert.equal(parseAddress("<>"), null);
	assert.equal(parseAddress(">"), null);
	for (const hostile of [`${"<".repeat(100_000)}x`, `${"<".repeat(100_000)}>b>`]) {
		const { result, ms } = timed(() => parseAddress(hostile));
		assert.ok(ms < BUDGET_MS, `${ms} ms`);
		assert.equal(result, null);
	}
});

test("the composer's plain text drops tags in linear time without DOMParser", () => {
	assert.equal(typeof DOMParser, "undefined");
	assert.equal(htmlToPlainText("<p>Hi <b>there</b></p><<b>b>x"), "Hi there\nb>x");
	const { result, ms } = timed(() => htmlToPlainText(`${"<".repeat(100_000)}x`));
	assert.ok(ms < BUDGET_MS, `${ms} ms`);
	assert.equal(result.length, 100_001);
});

test("attachment names with long runs of dots are judged in linear time", () => {
	assert.equal(isExecutableFilename("invoice.pdf.exe. . "), true);
	assert.equal(hasDecoyExtension("invoice.pdf.exe"), true);
	const name = `a${".".repeat(100_000)}x`;
	const { ms } = timed(() => assessAttachmentRisk({ filename: name }));
	assert.ok(ms < BUDGET_MS, `${ms} ms`);
	assert.equal(timed(() => isExecutableFilename(`a${" ".repeat(100_000)}x.exe`)).result, true);
});

test("a cut through replacement characters is trimmed in linear time", () => {
	// A cut inside a multi-byte character still drops the half character.
	assert.equal(truncateUtf8("ab😀", 4), "ab");
	const value = `${"�".repeat(150_000)}${"a".repeat(500_000)}`;
	const { result, ms } = timed(() => truncateUtf8(value, 450_001));
	assert.ok(ms < BUDGET_MS * 2, `${ms} ms`);
	assert.equal(result, `${"�".repeat(150_000)}a`);
});

test("a colour with a long run of blanks is parsed in linear time", () => {
	assert.deepEqual(parseCssColour("red !important"), { rgb: [255, 0, 0], alpha: 1 });
	assert.deepEqual(parseCssColour("red   !important"), { rgb: [255, 0, 0], alpha: 1 });
	const { result, ms } = timed(() => parseCssColour(`red${" ".repeat(100_000)}x`));
	assert.ok(ms < BUDGET_MS, `${ms} ms`);
	assert.equal(result, null);
});

test("a conversation with thousands of people builds its chips in linear time", () => {
	const people = [];
	for (let index = 0; index < 5_000; index += 1) {
		people.push({ name: "Support", address: `support${index}@domain${index % 2_500}.test` });
	}
	const { result, ms } = timed(() => getThreadParticipants(people));
	assert.ok(ms < BUDGET_MS, `${ms} ms`);
	// One chip per domain; the second address at a domain is remembered on it.
	assert.equal(result.length, 2_500);
	assert.deepEqual(result[0], {
		name: "Support",
		address: "support0@domain0.test",
		otherAddresses: ["support2500@domain0.test"],
	});
});
