import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-email-text-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function load(entry, name) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, `${name}.mjs`),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
}

const { formatEmailAddress, parseEmailAddressParts } = await load("src/lib/email/address.ts", "address");
const { htmlToReadableText } = await load("src/lib/email/reply-content-utils.ts", "reply-content-utils");
const { htmlToPlainText } = await load("src/components/compose/rich-text-utils.ts", "rich-text-utils");

test("parses quoted and unquoted name-addr forms", () => {
	assert.deepEqual(parseEmailAddressParts('"Ada Lovelace" <ada@example.test>'), {
		name: "Ada Lovelace",
		address: "ada@example.test",
	});
	assert.deepEqual(parseEmailAddressParts("  Ada <ada@example.test> "), { name: "Ada", address: "ada@example.test" });
	assert.deepEqual(parseEmailAddressParts('"Ada"   <ada@example.test>'), { name: "Ada", address: "ada@example.test" });
	assert.deepEqual(parseEmailAddressParts("ada@example.test"), { name: null, address: "ada@example.test" });
});

test("leaves malformed name-addr values whole", () => {
	for (const value of [
		"<ada@example.test>",
		'"" <ada@example.test>',
		'A"da <ada@example.test>',
		"Ada <>",
		"Ada <a>b>",
	]) {
		assert.deepEqual(parseEmailAddressParts(value), { name: null, address: value });
	}
});

test("parses a long hostile header in linear time", () => {
	const value = `${"\t".repeat(50_000)}x<${"<".repeat(50_000)}`;
	const started = performance.now();
	parseEmailAddressParts(value);
	assert.ok(performance.now() - started < 250);
});

test("escapes backslashes and quotes in display names", () => {
	assert.equal(formatEmailAddress("a@example.test", 'A \\" B'), '"A \\\\\\" B" <a@example.test>');
	assert.equal(formatEmailAddress("a@example.test", null), "a@example.test");
});

test("decodes &amp; last so entities are not decoded twice", () => {
	assert.equal(htmlToReadableText("&amp;lt;b&amp;gt; &lt;i&gt;"), "&lt;b&gt; <i>");
});

test("strips tags in the DOM-free plain-text fallback", () => {
	assert.equal(htmlToPlainText('a<b class="x">c</b>d'), "acd");
	assert.equal(htmlToPlainText("<p>one</p>two<br>three"), "one\ntwo\nthree");
});
