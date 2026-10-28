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
		contents: `export { ImapConnection } from "./src/lib/imap/connection.ts";
export { MailServerRefusedError } from "./src/lib/net/errors.ts";
export { parseFetchUid } from "./src/lib/imap/protocol-utils.ts";
export { selectRemainingUids, chunk } from "./src/lib/import/imap-utils.ts";`,
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

const { ImapConnection, MailServerRefusedError, parseFetchUid, selectRemainingUids, chunk } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Fake socket: replies to each written command with the scripted response, split into small chunks. */
function fakeSocket(script, greeting = "* OK ready\r\n") {
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
	if (greeting) controller?.enqueue(encoder.encode(greeting));
	return { socket: { readable, writable, opened: Promise.resolve(), close: async () => undefined }, written };
}

/**
 * A STARTTLS-capable fake socket: plain until `startTls()`, which hands out a second scripted socket. `tail` is sent
 * right behind the STARTTLS OK, before the upgrade, as an attacker on the path would.
 */
function startTlsSocket({ plain, secure, tail = "" }) {
	const log = [];
	// A TLS session has no second greeting.
	const upgraded = fakeSocket((command, tag) => {
		log.push(`tls ${command.trim()}`);
		return secure(command, tag);
	}, "");
	let controller;
	const readable = new ReadableStream({
		start: (c) => {
			controller = c;
		},
	});
	const writable = new WritableStream({
		write(chunkBytes) {
			const command = decoder.decode(chunkBytes);
			log.push(`plain ${command.trim()}`);
			const tag = command.split(" ")[0];
			const reply = /STARTTLS/.test(command) ? `${tag} OK go ahead\r\n${tail}` : plain(command, tag);
			controller.enqueue(encoder.encode(reply));
		},
	});
	controller.enqueue(encoder.encode("* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n"));
	let upgrades = 0;
	const socket = {
		readable,
		writable,
		opened: Promise.resolve(),
		close: async () => undefined,
		startTls() {
			upgrades += 1;
			return upgraded.socket;
		},
	};
	return { socket, log, upgrades: () => upgrades };
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
	assert.match(written[0], /UID FETCH 10,11 \(UID FLAGS INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]\)/);
	assert.equal(decoder.decode(result.get("10").raw), bodyA);
	assert.equal(decoder.decode(result.get("11").raw), bodyB);
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

test("startTls upgrades the socket and forgets the capabilities announced in plain text", async () => {
	const { socket, log, upgrades } = startTlsSocket({
		plain: (_command, tag) => `${tag} BAD\r\n`,
		secure: (command, tag) =>
			/CAPABILITY/.test(command) ? `* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK\r\n` : `${tag} OK\r\n`,
	});
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	assert.deepEqual(imap.capabilities, ["IMAP4REV1", "STARTTLS", "LOGINDISABLED"]);
	await imap.startTls();
	assert.equal(upgrades(), 1);
	assert.deepEqual(imap.capabilities, []);
	assert.deepEqual(await imap.capability(), ["IMAP4REV1", "AUTH=PLAIN"]);
	assert.deepEqual(log, ["plain A0001 STARTTLS", "tls A0002 CAPABILITY"]);
});

test("startTls refuses bytes the server sent before the handshake", async () => {
	const { socket, upgrades } = startTlsSocket({
		plain: (_command, tag) => `${tag} OK\r\n`,
		secure: (_command, tag) => `${tag} OK\r\n`,
		tail: "* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n",
	});
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	await assert.rejects(
		imap.startTls(),
		(error) => error instanceof MailServerRefusedError && /before the TLS handshake/.test(error.message),
	);
	assert.equal(upgrades(), 0);
});

test("a refused STARTTLS is a refusal, not a retryable failure", async () => {
	const { socket } = fakeSocket((_command, tag) => `${tag} BAD no TLS here\r\n`);
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	await assert.rejects(imap.startTls(), MailServerRefusedError);
});

test("AUTHENTICATE PLAIN without SASL-IR sends the token after the continuation, and failures never echo it", async () => {
	const token = Buffer.from("\0user\0secret").toString("base64");
	const { socket, written } = fakeSocket((command, tag) => {
		if (command.startsWith(token)) return "A0001 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n";
		if (/AUTHENTICATE PLAIN/.test(command)) return "+ \r\n";
		return `${tag} OK\r\n`;
	});
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	await assert.rejects(imap.authenticatePlain(token, false), (error) => {
		assert.match(error.message, /^IMAP sign-in failed: NO \[AUTHENTICATIONFAILED\]/);
		assert.ok(!error.message.includes(token));
		return true;
	});
	assert.deepEqual(written, ["A0001 AUTHENTICATE PLAIN\r\n", `${token}\r\n`]);

	const ok = fakeSocket((command, tag) => `${tag} OK [CAPABILITY IMAP4rev1 IDLE] signed in\r\n`);
	const signedIn = new ImapConnection(ok.socket);
	await signedIn.readGreeting();
	await signedIn.authenticatePlain(token, true);
	assert.deepEqual(ok.written, [`A0001 AUTHENTICATE PLAIN ${token}\r\n`]);
	assert.deepEqual(signedIn.capabilities, ["IMAP4REV1", "IDLE"]);
});

test("a greeting other than OK or PREAUTH is refused, and PREAUTH is reported", async () => {
	const bye = fakeSocket(() => "", "* BYE busy\r\n");
	await assert.rejects(new ImapConnection(bye.socket).readGreeting(), /OK greeting/);
	const preauth = fakeSocket(() => "", "* PREAUTH hi\r\n");
	assert.equal(await new ImapConnection(preauth.socket).readGreeting(), true);
});

test("a silent server times out per command and the socket is closed, whatever the runtime", async (t) => {
	// Fake timers: the deadline fires when the test moves the clock, never by real time. `Date` stays real, so by the
	// wall clock the timer fires before the deadline, as real timers sometimes do; the socket must be closed anyway.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let closed = 0;
	const never = {
		readable: new ReadableStream(),
		writable: new WritableStream(),
		opened: Promise.resolve(),
		close: async () => {
			closed += 1;
		},
	};
	const imap = new ImapConnection(never, { commandTimeoutMs: 60_000 });
	const greeting = assert.rejects(imap.readGreeting(), /did not answer in time/);
	assert.equal(closed, 0);
	t.mock.timers.tick(60_000);
	await greeting;
	assert.equal(closed, 1);
});

test("a FETCH whose literals add up past the batch cap is refused", async () => {
	const body = "Subject: x\r\n\r\nbody\r\n";
	const { socket } = fakeSocket((command, tag) =>
		command.includes("UID FETCH")
			? `* 1 FETCH (UID 1 BODY[] {${body.length}}\r\n${body})\r\n* 2 FETCH (UID 2 BODY[] {${body.length}}\r\n${body})\r\n${tag} OK\r\n`
			: `${tag} OK\r\n`,
	);
	const imap = new ImapConnection(socket, { fetchBatchBytes: body.length + 1 });
	await imap.readGreeting();
	await assert.rejects(imap.fetchMessages(["1", "2"]), (error) => {
		assert.match(error.message, /^The IMAP server sent more than .* MB in one fetch$/);
		return true;
	});
});

/**
 * A socket that answers the first UID FETCH by sending `total` bytes of one literal, `piece` bytes every `everyMs`,
 * then the tagged OK. `total: Infinity` never ends.
 */
function streamingSocket({ total, piece, everyMs }) {
	let controller;
	let timer;
	const readable = new ReadableStream({
		start: (c) => {
			controller = c;
			c.enqueue(encoder.encode("* OK ready\r\n"));
		},
		cancel: () => clearInterval(timer),
	});
	const writable = new WritableStream({
		write(bytes) {
			const command = decoder.decode(bytes);
			const tag = command.split(" ")[0];
			if (!command.includes("UID FETCH")) return controller.enqueue(encoder.encode(`${tag} OK\r\n`));
			const size = Number.isFinite(total) ? total : 1024 * 1024 * 1024;
			controller.enqueue(encoder.encode(`* 1 FETCH (UID 1 BODY[] {${size}}\r\n`));
			let sent = 0;
			timer = setInterval(() => {
				const count = Math.min(piece, size - sent);
				controller.enqueue(new Uint8Array(count).fill(120));
				sent += count;
				if (sent >= size) {
					clearInterval(timer);
					controller.enqueue(encoder.encode(`)\r\n${tag} OK done\r\n`));
				}
			}, everyMs);
			// Never keep the test process alive.
			timer.unref?.();
		},
	});
	return { readable, writable, opened: Promise.resolve(), close: async () => clearInterval(timer) };
}

test("arriving bytes extend the deadline: a slow but steady FETCH finishes past the base timeout", async () => {
	// 3000 bytes at 2000 B/s take 1.5 s; the base deadline is 300 ms, and each byte earns 1 ms (1000 B/s).
	const imap = new ImapConnection(streamingSocket({ total: 3000, piece: 100, everyMs: 50 }), {
		commandTimeoutMs: 300,
		minBytesPerSecond: 1000,
		commandMaxMs: 10_000,
	});
	await imap.readGreeting();
	const started = Date.now();
	const fetched = await imap.fetchMessages(["1"]);
	assert.equal(fetched.get("1").raw.byteLength, 3000);
	assert.ok(Date.now() - started > 1000);
});

test("a trickle earns next to nothing and still times out", async () => {
	const imap = new ImapConnection(streamingSocket({ total: Infinity, piece: 1, everyMs: 20 }), {
		commandTimeoutMs: 300,
		minBytesPerSecond: 1000,
		commandMaxMs: 10_000,
		literalBytes: 2 * 1024 * 1024 * 1024,
		fetchBatchBytes: 2 * 1024 * 1024 * 1024,
	});
	await imap.readGreeting();
	const started = Date.now();
	await assert.rejects(imap.fetchMessages(["1"]), /did not answer in time/);
	assert.ok(Date.now() - started < 1000, "50 B/s buys about 15 ms");
});

test("a fast stream that never ends stops at the hard cap", async () => {
	const imap = new ImapConnection(streamingSocket({ total: Infinity, piece: 64 * 1024, everyMs: 5 }), {
		commandTimeoutMs: 100,
		minBytesPerSecond: 1000,
		commandMaxMs: 600,
		literalBytes: 2 * 1024 * 1024 * 1024,
		fetchBatchBytes: 2 * 1024 * 1024 * 1024,
	});
	await imap.readGreeting();
	const started = Date.now();
	await assert.rejects(imap.fetchMessages(["1"]), /did not answer in time/);
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 550 && elapsed < 2000, `stopped after ${elapsed} ms`);
});

test("a literal is read into a buffer of exactly its size, and bytes behind it stay buffered", async () => {
	const body = "y".repeat(70_000);
	const { socket } = fakeSocket((command, tag) =>
		command.includes("UID FETCH")
			? `* 1 FETCH (UID 3 BODY[] {${body.length}}\r\n${body})\r\n${tag} OK\r\n`
			: `${tag} OK\r\n`,
	);
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	const raw = (await imap.fetchMessages(["3"])).get("3").raw;
	assert.equal(raw.byteLength, body.length);
	assert.equal(decoder.decode(raw), body);
	// The connection is still in step: the next command reads its own answer.
	assert.deepEqual(await imap.command("NOOP"), ["A0002 OK"]);
});

test("fetchMessages returns flags, INTERNALDATE and size wherever the server puts them, and skips flag-only responses", async () => {
	const body = "Subject: a\r\n\r\nhello\r\n";
	const { socket } = fakeSocket((command, tag) =>
		command.includes("UID FETCH")
			? `* 1 FETCH (UID 4 FLAGS (\\Seen) INTERNALDATE "27-Oct-2026 10:00:00 +0000" RFC822.SIZE ${body.length} BODY[] {${body.length}}\r\n${body})\r\n` +
				`* 2 FETCH (BODY[] {${body.length}}\r\n${body} UID 5 FLAGS (\\Flagged \\Answered))\r\n` +
				`* 3 FETCH (UID 6 FLAGS (\\Deleted))\r\n` +
				`${tag} OK done\r\n`
			: `${tag} OK\r\n`,
	);
	const imap = new ImapConnection(socket);
	await imap.readGreeting();
	const result = await imap.fetchMessages(["4", "5", "6"]);
	assert.deepEqual([...result.keys()], ["4", "5"]);
	const first = result.get("4");
	assert.deepEqual(first.flags, ["\\Seen"]);
	assert.equal(first.internalDate.toISOString(), "2026-10-27T10:00:00.000Z");
	assert.equal(first.size, body.length);
	const second = result.get("5");
	assert.deepEqual(second.flags, ["\\Flagged", "\\Answered"]);
	assert.equal(second.internalDate, null);
	assert.equal(second.size, null);
	assert.equal(decoder.decode(second.raw), body);
});
