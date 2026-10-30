import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The linear format=flowed decoder must return exactly what postal-mime 2.7's quadratic one returns.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-flowed-text-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { decodeFlowedText } from "./src/lib/email/flowed-text-utils.ts";
			export { default as MimeNode } from "./node_modules/postal-mime/src/mime-node.js";
		`,
		resolveDir: root,
		sourcefile: "flowed-text-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { decodeFlowedText, MimeNode } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const original = (text, delSp) => MimeNode.prototype.decodeFlowedText.call(null, text, delSp);

const samples = {
	paragraph:
		"This is a long paragraph that the sender's client \r\nwrapped at seventy-eight \r\ncharacters.\r\n\r\nA second one.\r\n",
	delSpWords: "Hello the \r\nre, wo \r\nrld  \r\nagain\r\n",
	quoted: "> Quoted text that \r\n> continues here.\r\n>> Deeper \r\n>> quote.\r\nReply \r\ntext.\r\n",
	signature: "Thanks \r\n-- \r\nJane Doe \r\nExample Ltd.\r\n",
	signatureFirst: "-- \r\nJust a signature\r\n",
	signatureAfterFlowedText: "end of a line \r\n-- \r\nnot a separator\r\n",
	spaceStuffed: " From the archive \r\n >quoted-looking\r\n  two spaces\r\n",
	emptyLines: "\r\n\r\na \r\n\r\nb  \r\n \r\n\r\n",
	bareLf: "lf only \nline \nend\n",
	trailingSpaces: "many    \r\nspaces   \r\n",
	empty: "",
	onlySpace: " ",
	dashes: "-- \r\n-- \r\n--  \r\nx",
};

test("decodes normal flowed mail exactly as postal-mime 2.7 does, with and without DelSp", () => {
	for (const [name, text] of Object.entries(samples))
		for (const delSp of [false, true])
			assert.equal(decodeFlowedText(text, delSp), original(text, delSp), `${name}, delSp ${delSp}`);
	assert.equal(decodeFlowedText(samples.delSpWords, true), "Hello there, world again\n");
	assert.equal(decodeFlowedText(samples.signatureFirst, false), "-- \nJust a signature\n");
	assert.equal(
		decodeFlowedText(samples.paragraph, false),
		"This is a long paragraph that the sender's client wrapped at seventy-eight characters.\n\nA second one.\n",
	);
});

test("matches postal-mime 2.7 on random flowed-looking text", () => {
	const alphabet = [" ", " ", "a", "b", "-", "--", "-- ", ">", "\n", "\r\n", "\r\n", "\r"];
	let seed = 1;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let round = 0; round < 20_000; round++) {
		const length = Math.floor(random() * 40);
		let text = "";
		for (let index = 0; index < length; index++) text += alphabet[Math.floor(random() * alphabet.length)];
		for (const delSp of [false, true])
			assert.equal(decodeFlowedText(text, delSp), original(text, delSp), JSON.stringify({ text, delSp }));
	}
});

test("stays linear: 39,000 flowed lines in well under a second", () => {
	const text = ("a".repeat(59) + " \r\n").repeat(39_000);
	const started = performance.now();
	const decoded = decodeFlowedText(text, true);
	assert.ok(performance.now() - started < 1000);
	assert.equal(decoded.length, 39_000 * 59);
});
