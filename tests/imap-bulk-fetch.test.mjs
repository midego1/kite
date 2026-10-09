import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-imap-bulk-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { ImapConnection } from "./src/lib/import/imap.ts";
export { parseFetchUid, selectRemainingUids, chunk } from "./src/lib/import/imap-utils.ts";`,
		resolveDir: root,
		sourcefile: "imap-bulk-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { ImapConnection, parseFetchUid, selectRemainingUids, chunk } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Fake socket: replies to each written command with the scripted response, split into small chunks. */
function fakeSocket(script) {
	let controller;
	const readable = new ReadableStream({
		start: (c) => {
			controller = c;
		},
	});
	const written = [];
	const writable = new WritableStream({
		write(chunkBytes) {
			const command = decoder.decode(chunkBytes);
			written.push(command);
			const tag = command.split(" ")[0];
			const reply = encoder.encode(script(command, tag));
			for (let index = 0; index < reply.length; index += 7) controller.enqueue(reply.slice(index, index + 7));
		},
	});
	controller?.enqueue(encoder.encode("* OK ready\r\n"));
	return { socket: { readable, writable }, written };
}

test("fetchMessages reads several literals from one UID FETCH, UID before or after the body", async () => {
	const bodyA = "Subject: a\r\n\r\nhello\r\n";
	const bodyB = "Subject: b\r\n\r\n{5}\r\nnot a literal\r\n";
	const { socket, written } = fakeSocket((command, tag) => {
		if (command.includes("UID FETCH")) {
			return (
				`* 1 FETCH (UID 10 BODY[] {${bodyA.length}}\r\n${bodyA})\r\n` +
				`* 2 FETCH (BODY[] {${bodyB.length}}\r\n${bodyB} UID 11)\r\n` +
				`* 3 FETCH (FLAGS (\\Seen))\r\n` +
				`${tag} OK done\r\n`
			);
		}
		return `${tag} OK\r\n`;
	});
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	const result = await imap.fetchMessages(["10", "11"]);
	assert.match(written[0], /UID FETCH 10,11 \(UID BODY\.PEEK\[\]\)/);
	assert.equal(decoder.decode(result.get("10")), bodyA);
	assert.equal(decoder.decode(result.get("11")), bodyB);
	assert.equal(result.size, 2);
});

test("large literals survive buffer growth", async () => {
	const body = "x".repeat(300_000) + "\r\n";
	const { socket } = fakeSocket((command, tag) =>
		command.includes("UID FETCH")
			? `* 1 FETCH (UID 7 BODY[] {${body.length}}\r\n${body})\r\n${tag} OK\r\n`
			: `${tag} OK\r\n`,
	);
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	const raw = await imap.fetchMessage("7");
	assert.equal(raw.byteLength, body.length);
});

test("failed FETCH rejects", async () => {
	const { socket } = fakeSocket((_command, tag) => `${tag} NO nope\r\n`);
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	await assert.rejects(imap.fetchMessages(["1"]), /IMAP fetch failed/);
});

test("helpers", () => {
	assert.equal(parseFetchUid("* 4 FETCH (UID 99 BODY[] {3}"), "99");
	assert.equal(parseFetchUid(")"), null);
	assert.deepEqual(selectRemainingUids(["1", "5", "3", "x"], null), [5, 3, 1]);
	assert.deepEqual(selectRemainingUids(["1", "5", "3"], 5), [3, 1]);
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
