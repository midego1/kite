import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-search-from-exact-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/search/query-utils.ts")],
	outfile: join(outDir, "query.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { parseSearchQuery, exactSenderMatch, buildFtsMatch } = await import(
	pathToFileURL(join(outDir, "query.mjs")).href
);

test("from: with one whole address is an exact sender, quoted or not; names and fragments stay word matches", () => {
	assert.equal(parseSearchQuery('from:"Hi@Cursor.com"').fromAddress, "hi@cursor.com");
	assert.equal(parseSearchQuery("from:hi@cursor.com is:unread").fromAddress, "hi@cursor.com");
	assert.equal(parseSearchQuery('from:"hi@cursor.com"').from, undefined);
	assert.equal(parseSearchQuery('from:"sam okoro"').from, "sam okoro");
	assert.equal(parseSearchQuery("from:maya").from, "maya");
	assert.equal(parseSearchQuery("from:@cursor.com").from, "@cursor.com");
	// The exact sender no longer needs the full-text index.
	assert.equal(buildFtsMatch(parseSearchQuery('from:"hi@cursor.com"')), null);
});

test("the exact sender predicate matches the address alone or ending a header, and nothing close to it", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, from_addr TEXT)");
	const senders = [
		"hi@cursor.com",
		"Hi@Cursor.com",
		'"Roshni at Cursor" <hi@cursor.com>',
		"Roshni <HI@cursor.com>  ",
		"x.hi@cursor.com",
		"hi@cursor.com.evil.test",
		"ahi@cursor.com",
		'"hi@cursor.com" <x@evil.test>',
		"Roshni <hi@cursor.com> <x@evil.test>",
		"a.b@x.test",
		"a+b@x.test",
		"a_b@x.test",
		"axb@x.test",
		"100%@x.test",
		"1000@x.test",
	];
	const insert = db.prepare("INSERT INTO messages (from_addr) VALUES (?)");
	for (const sender of senders) insert.run(sender);
	const select = db.prepare(
		"SELECT from_addr FROM messages WHERE (lower(trim(from_addr)) = ? OR lower(trim(from_addr)) LIKE ? ESCAPE '\\') ORDER BY id",
	);
	const find = (address) => {
		const { equals, endsWith } = exactSenderMatch(address);
		return select.all(equals, endsWith).map((row) => row.from_addr);
	};
	assert.deepEqual(find("hi@cursor.com"), [
		"hi@cursor.com",
		"Hi@Cursor.com",
		'"Roshni at Cursor" <hi@cursor.com>',
		"Roshni <HI@cursor.com>  ",
	]);
	assert.deepEqual(find("a+b@x.test"), ["a+b@x.test"]);
	assert.deepEqual(find("a.b@x.test"), ["a.b@x.test"]);
	assert.deepEqual(find("a_b@x.test"), ["a_b@x.test"]);
	assert.deepEqual(find("100%@x.test"), ["100%@x.test"]);
});
