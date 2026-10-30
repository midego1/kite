import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-contact-card-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const card = await bundle("src/components/contacts/contact-card-utils.ts", "card.mjs");
const thread = await bundle("src/components/messages/conversation-thread-utils.ts", "thread.mjs");

test("own addresses match case-insensitively and an empty address never does", () => {
	assert.equal(card.isOwnAddress("Me@Example.com", ["me@example.com", "alias@example.com"]), true);
	assert.equal(card.isOwnAddress("Michiel <alias@example.com>", ["me@example.com", "alias@example.com"]), true);
	assert.equal(card.isOwnAddress("hi@cursor.com", ["me@example.com"]), false);
	assert.equal(card.isOwnAddress("", [""]), false);
});

test("the tooltip shows the full address and how many others the person used", () => {
	assert.equal(card.participantTooltip("hi@cursor.com"), "hi@cursor.com");
	assert.equal(card.participantTooltip("Roshni <hi@cursor.com>", ["r@cursor.com"]), "hi@cursor.com (+1 more address)");
	assert.equal(card.participantTooltip("hi@cursor.com", ["a@x.test", "b@x.test"]), "hi@cursor.com (+2 more addresses)");
	assert.equal(card.participantTooltip(""), null);
});

test("the search action lists mail from the address and names the person", () => {
	assert.equal(card.fromSearchQuery("Roshni at Cursor <hi@cursor.com>"), "from:hi@cursor.com");
	assert.equal(card.showMailFromLabel("Roshni", "hi@cursor.com"), "Show all mail from Roshni");
	assert.equal(card.showMailFromLabel(" ", "hi@cursor.com"), "Show all mail from hi@cursor.com");
});

test("participants: one chip per address, a name used with several addresses stays one chip", () => {
	const people = thread.getThreadParticipants([
		{ name: "Roshni at Cursor", address: "hi@cursor.com" },
		{ name: "Michiel", address: "me@example.com" },
		{ name: "HI@cursor.com", address: "HI@cursor.com" },
		{ name: "Roshni at Cursor", address: "roshni@cursor.com" },
		{ name: "roshni at cursor", address: "r2@cursor.com" },
		{ name: "support@a.test", address: "support@a.test" },
		{ name: "support@b.test", address: "support@b.test" },
	]);
	assert.deepEqual(
		people.map((person) => [person.name, person.address, person.otherAddresses ?? []]),
		[
			["Roshni at Cursor", "hi@cursor.com", ["roshni@cursor.com", "r2@cursor.com"]],
			["Michiel", "me@example.com", []],
			["support@a.test", "support@a.test", []],
			["support@b.test", "support@b.test", []],
		],
	);
});

test("participants without an address keep one chip per name", () => {
	const people = thread.getThreadParticipants([
		{ name: "Undisclosed", address: "" },
		{ name: "undisclosed", address: "" },
	]);
	assert.equal(people.length, 1);
});
