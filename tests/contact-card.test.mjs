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

test("the tooltip shows the full address and every other address of the person", () => {
	assert.equal(card.participantTooltip("hi@cursor.com"), "hi@cursor.com");
	assert.equal(card.participantTooltip("Roshni <hi@cursor.com>", ["r@cursor.com"]), "hi@cursor.com, also r@cursor.com");
	assert.equal(
		card.participantTooltip("hi@cursor.com", ["a@cursor.com", "b@cursor.com"]),
		"hi@cursor.com, also a@cursor.com, b@cursor.com",
	);
	assert.equal(card.participantTooltip(""), null);
});

test("the search action lists mail from the exact address and says it searches the Inbox", () => {
	assert.equal(card.fromSearchQuery("Roshni at Cursor <hi@cursor.com>"), 'from:"hi@cursor.com"');
	assert.equal(card.showMailFromLabel("Roshni", "hi@cursor.com"), "Search Inbox for mail from Roshni");
	assert.equal(card.showMailFromLabel(" ", "hi@cursor.com"), "Search Inbox for mail from hi@cursor.com");
});

test("read-only shares get neither New email nor Edit or Block; send-only shares can write but not edit", () => {
	assert.deepEqual(card.contactCardAccess("read_only"), { canSend: false, canEdit: false });
	assert.deepEqual(card.contactCardAccess("send_as"), { canSend: true, canEdit: false });
	assert.deepEqual(card.contactCardAccess("send_on_behalf"), { canSend: true, canEdit: false });
	assert.deepEqual(card.contactCardAccess("full_access"), { canSend: true, canEdit: true });
	assert.deepEqual(card.contactCardAccess(null), { canSend: false, canEdit: false });
});

test("participants: one chip per address; a name merges only within one domain", () => {
	const people = thread.getThreadParticipants([
		{ name: "Roshni at Cursor", address: "hi@cursor.com" },
		{ name: "Michiel", address: "me@example.com" },
		{ name: "HI@cursor.com", address: "HI@cursor.com" },
		{ name: "Roshni at Cursor", address: "roshni@cursor.com" },
		{ name: "roshni at cursor", address: "r2@CURSOR.com" },
		{ name: "Roshni at Cursor", address: "x@evil.test" },
		{ name: "support@a.test", address: "support@a.test" },
		{ name: "support@b.test", address: "support@b.test" },
	]);
	assert.deepEqual(
		people.map((person) => [person.name, person.address, person.otherAddresses ?? []]),
		[
			["Roshni at Cursor", "hi@cursor.com", ["roshni@cursor.com", "r2@CURSOR.com"]],
			["Michiel", "me@example.com", []],
			["Roshni at Cursor", "x@evil.test", []],
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
