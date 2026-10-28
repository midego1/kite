import { createServer as createNetServer } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";

/**
 * A small in-process IMAP4rev1 server for tests: in-memory folders with UIDs, `CAPABILITY`, `STARTTLS`, `LOGIN`,
 * `AUTHENTICATE PLAIN` (with or without `SASL-IR`), `LIST`, `SELECT`/`EXAMINE`, `UID SEARCH ALL`,
 * `UID FETCH … BODY.PEEK[]`, `NOOP` and `LOGOUT`. It is hand-written so tests can inject failures: no STARTTLS,
 * a STARTTLS response with injected bytes behind it, `LOGINDISABLED`, failed sign-ins. Every command is recorded with
 * whether the connection was encrypted at the time. Never point it at, or copy it from, a real provider.
 *
 * Options:
 * - `tls`: `{ cert, key }` (from `test-certificate.mjs`); required for `implicitTls` and `starttls`.
 * - `implicitTls`: the whole connection is TLS (port 993 style).
 * - `starttls`: offer STARTTLS on a plain connection (port 143 style).
 * - `injectAfterStartTls`: bytes sent right after the STARTTLS OK, before the handshake (a downgrade attack).
 * - `authPlain`, `saslIr`: advertise `AUTH=PLAIN` and `SASL-IR`.
 * - `loginDisabledWithoutTls`: advertise `LOGINDISABLED` and refuse sign-in until the connection is encrypted.
 * - `greetingCapabilities`: put `[CAPABILITY …]` in the greeting (default true).
 * - `specialUse`: advertise SPECIAL-USE and report `folderAttributes` (`{ [name]: ["\\Sent"] }`) in LIST.
 * - `statusSize`: advertise STATUS=SIZE. `delimiter`: the hierarchy delimiter (default `/`).
 * - `fetchDelayMs`: answer every UID FETCH that much later (a slow server, so a test can pause mid-run).
 * - `fetchGate`: a promise, or a function from the FETCH's number (0, 1, …) to one; each UID FETCH is answered only once
 *   its promise resolves (a FETCH that outlasts a lease).
 * - `examineRefusals`: `{ [folder]: "NO [THROTTLED] …" }`, the tagged answer to SELECT or EXAMINE of that folder.
 * - `gmail`: advertise X-GM-EXT-1 and report each message's `labels` in FETCH when asked for X-GM-LABELS.
 * - `users`: `{ [username]: password }`. `LOGIN` takes quoted strings or synchronizing literals.
 * - Misbehaviour: `hugeLiteral` (a FETCH announcing a 4 GB literal), `endlessLine` (a greeting that never ends),
 *   `slowLoris` (a greeting trickled one byte at a time, forever), `silent` (no greeting at all), `silentTls` (OK to
 *   STARTTLS, then no handshake), `secondChallenge` (a second `+` during AUTHENTICATE PLAIN), `untaggedFlood` (CAPABILITY answered by
 *   an endless stream of untagged lines of that many bytes each).
 * - `folders`: `{ [name]: [message, …] }`, each a raw message or `{ raw, flags, internalDate }` (an IMAP date-time
 *   string); UIDs count up from 1 per folder. FETCH reports `FLAGS`, `INTERNALDATE` and `RFC822.SIZE` before the
 *   body, or after it with `attributesAfterLiteral`.
 */
export async function startFakeImap(options = {}) {
	let fetches = 0;
	const users = options.users ?? { "user@example.test": "app-password" };
	const folders = new Map();
	const commands = [];
	const connections = new Set();
	let nextLoginFails = false;

	function addMessage(folder, message) {
		if (!folders.has(folder)) folders.set(folder, { nextUid: 1, uidValidity: 1, messages: [] });
		const entry = folders.get(folder);
		const uid = entry.nextUid++;
		const {
			raw,
			flags = [],
			internalDate = "27-Oct-2026 10:00:00 +0000",
			labels = [],
		} = typeof message === "string" || Buffer.isBuffer(message) ? { raw: message } : message;
		entry.messages.push({ uid, raw: Buffer.from(raw), flags, internalDate, labels });
		return uid;
	}

	/** A new UIDVALIDITY renumbers the folder's messages from 1, as a server that rebuilt it would. */
	function bumpUidValidity(folder) {
		const entry = folders.get(folder);
		entry.uidValidity += 1;
		entry.messages.forEach((message, index) => {
			message.uid = index + 1;
		});
		entry.nextUid = entry.messages.length + 1;
	}

	const delimiter = options.delimiter ?? "/";
	/** An IMAP quoted string: backslashes first, then quotes. */
	const quoted = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const listLine = (folder) => {
		const attributes = ["\\HasNoChildren", ...(options.specialUse ? (options.folderAttributes?.[folder] ?? []) : [])];
		return `* LIST (${attributes.join(" ")}) "${delimiter}" ${quoted(folder)}\r\n`;
	};
	const labelList = (labels) =>
		`(${labels.map((label) => (label.startsWith("\\") ? label : quoted(label))).join(" ")})`;
	if (!options.folders) addMessage("INBOX", sampleMessage(1));
	for (const [name, messages] of Object.entries(options.folders ?? {})) {
		if (!folders.has(name)) folders.set(name, { nextUid: 1, uidValidity: 1, messages: [] });
		for (const raw of messages) addMessage(name, raw);
	}

	function handle(socket, encrypted) {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => undefined);
		const state = {
			socket,
			encrypted,
			authenticated: false,
			selected: null,
			pendingAuth: null,
			challenged: false,
			buffer: Buffer.alloc(0),
			partial: "",
			literal: null,
		};

		const capabilities = () => {
			const list = ["IMAP4rev1"];
			if (!state.encrypted && options.starttls) list.push("STARTTLS");
			if (!state.encrypted && options.loginDisabledWithoutTls) list.push("LOGINDISABLED");
			if (options.authPlain) list.push("AUTH=PLAIN");
			if (options.saslIr) list.push("SASL-IR");
			if (state.authenticated && options.specialUse) list.push("SPECIAL-USE");
			if (state.authenticated && options.statusSize) list.push("STATUS=SIZE");
			if (state.authenticated && options.gmail) list.push("X-GM-EXT-1");
			return list.join(" ");
		};
		const send = (text) => state.socket.write(text);

		// Lines, with a `{n}` literal folded back into the line as a quoted string once its bytes have arrived.
		const onData = (chunk) => {
			state.buffer = Buffer.concat([state.buffer, chunk]);
			while (true) {
				if (state.literal !== null) {
					if (state.buffer.length < state.literal) return;
					const value = state.buffer.subarray(0, state.literal).toString("utf8");
					state.buffer = state.buffer.subarray(state.literal);
					state.literal = null;
					state.partial += `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
					continue;
				}
				const index = state.buffer.indexOf("\r\n");
				if (index < 0) return;
				const line = state.partial + state.buffer.subarray(0, index).toString("utf8");
				state.buffer = state.buffer.subarray(index + 2);
				const literal = state.pendingAuth ? null : line.match(/\{(\d+)\}$/);
				if (literal) {
					state.partial = line.slice(0, -literal[0].length);
					state.literal = Number(literal[1]);
					send("+ go ahead\r\n");
					continue;
				}
				state.partial = "";
				if (respond(line) === "starttls") return;
			}
		};

		const signIn = (tag, username, password) => {
			if (!state.encrypted && options.loginDisabledWithoutTls) return send(`${tag} NO [PRIVACYREQUIRED] TLS first\r\n`);
			if (nextLoginFails || users[username] !== password) {
				nextLoginFails = false;
				return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
			}
			state.authenticated = true;
			send(`${tag} OK [CAPABILITY ${capabilities()}] Signed in\r\n`);
		};

		const plain = (tag, token) => {
			const [, username, password] = Buffer.from(token, "base64").toString("utf8").split("\0");
			signIn(tag, username, password);
		};

		function respond(line) {
			commands.push({ line, encrypted: state.encrypted });
			if (state.pendingAuth) {
				const tag = state.pendingAuth;
				if (line.trim() === "*") {
					state.pendingAuth = null;
					return send(`${tag} BAD Authentication cancelled\r\n`);
				}
				if (options.secondChallenge && !state.challenged) {
					state.challenged = true;
					return send("+ again\r\n");
				}
				state.pendingAuth = null;
				plain(tag, line.trim());
				return;
			}
			const [tag, rawName, ...rest] = line.split(" ");
			const name = (rawName ?? "").toUpperCase();
			const args = rest.join(" ");
			if (name === "CAPABILITY" && options.untaggedFlood)
				return streamUntaggedFlood(state.socket, options.untaggedFlood);
			if (name === "CAPABILITY") return send(`* CAPABILITY ${capabilities()}\r\n${tag} OK done\r\n`);
			if (name === "NOOP") return send(`${tag} OK done\r\n`);
			if (name === "LOGOUT") {
				send(`* BYE logging out\r\n${tag} OK done\r\n`);
				state.socket.end();
				return;
			}
			if (name === "STARTTLS") {
				if (state.encrypted || !options.starttls) return send(`${tag} BAD STARTTLS not available\r\n`);
				state.socket.off("data", onData);
				send(`${tag} OK Begin TLS negotiation now\r\n${options.injectAfterStartTls ?? ""}`);
				if (options.silentTls) return "starttls";
				const secure = new TLSSocket(state.socket, { isServer: true, ...options.tls });
				secure.on("error", () => undefined);
				connections.add(secure);
				secure.on("close", () => connections.delete(secure));
				state.socket = secure;
				state.encrypted = true;
				state.buffer = Buffer.alloc(0);
				secure.on("data", onData);
				return "starttls";
			}
			if (name === "LOGIN") {
				const [username, password] = parseQuoted(args);
				return signIn(tag, username, password);
			}
			if (name === "AUTHENTICATE") {
				const [mechanism, token] = args.split(" ");
				if (mechanism?.toUpperCase() !== "PLAIN" || !options.authPlain) return send(`${tag} NO unsupported\r\n`);
				if (token) return plain(tag, token);
				state.pendingAuth = tag;
				return send("+ \r\n");
			}
			if (!state.authenticated) return send(`${tag} BAD sign in first\r\n`);
			if (name === "LIST") return send(`${[...folders.keys()].map(listLine).join("")}${tag} OK done\r\n`);
			if (name === "STATUS") {
				const [folder] = parseQuoted(args);
				const entry = folders.get(folder);
				if (!entry) return send(`${tag} NO [NONEXISTENT] No such folder\r\n`);
				const size = entry.messages.reduce((sum, message) => sum + message.raw.length, 0);
				const items = `MESSAGES ${entry.messages.length} UIDNEXT ${entry.nextUid} UIDVALIDITY ${entry.uidValidity}`;
				return send(
					`* STATUS ${quoted(folder)} (${items}${options.statusSize ? ` SIZE ${size}` : ""})\r\n${tag} OK done\r\n`,
				);
			}
			if (name === "SELECT" || name === "EXAMINE") {
				const [folder] = parseQuoted(args);
				const refusal = options.examineRefusals?.[folder];
				if (refusal) return send(`${tag} ${refusal}\r\n`);
				const entry = folders.get(folder);
				if (!entry) return send(`${tag} NO [NONEXISTENT] No such folder\r\n`);
				state.selected = folder;
				return send(
					`* ${entry.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${entry.uidValidity}] ok\r\n* OK [UIDNEXT ${entry.nextUid}] ok\r\n${tag} OK [READ-ONLY] done\r\n`,
				);
			}
			const entry = state.selected ? folders.get(state.selected) : null;
			if (name === "UID" && entry) {
				const [sub, set] = args.split(" ");
				if (sub.toUpperCase() === "SEARCH")
					return send(`* SEARCH ${entry.messages.map((message) => message.uid).join(" ")}\r\n${tag} OK done\r\n`);
				if (sub.toUpperCase() === "FETCH") {
					const wanted = new Set(set.split(",").map(Number));
					if (options.hugeLiteral) return send(`* 1 FETCH (UID 1 BODY[] {4000000000}\r\n${"x".repeat(1000)}`);
					if (options.fetchGate) {
						const gate = typeof options.fetchGate === "function" ? options.fetchGate(fetches++) : options.fetchGate;
						gate.then(() => !state.socket.destroyed && respondFetch(tag, args, entry, wanted));
						return;
					}
					if (options.fetchDelayMs) {
						const later = () => respondFetch(tag, args, entry, wanted);
						setTimeout(() => !state.socket.destroyed && later(), options.fetchDelayMs);
						return;
					}
					return respondFetch(tag, args, entry, wanted);
				}
			}
			return send(`${tag} BAD unknown command\r\n`);
		}

		function respondFetch(tag, args, entry, wanted) {
			entry.messages.forEach((message, index) => {
				if (!wanted.has(message.uid)) return;
				const labels = /X-GM-LABELS/i.test(args) ? ` X-GM-LABELS ${labelList(message.labels)}` : "";
				const attributes = `FLAGS (${message.flags.join(" ")}) INTERNALDATE "${message.internalDate}" RFC822.SIZE ${message.raw.length}${labels}`;
				if (options.attributesAfterLiteral) {
					send(`* ${index + 1} FETCH (BODY[] {${message.raw.length}}\r\n`);
					send(message.raw);
					send(` UID ${message.uid} ${attributes})\r\n`);
					return;
				}
				send(`* ${index + 1} FETCH (UID ${message.uid} ${attributes} BODY[] {${message.raw.length}}\r\n`);
				send(message.raw);
				send(")\r\n");
			});
			send(`${tag} OK done\r\n`);
		}

		state.socket.on("data", onData);
		if (options.silent) return;
		if (options.endlessLine) return streamEndlessLine(state.socket);
		if (options.slowLoris) {
			const timer = setInterval(() => (socket.destroyed ? clearInterval(timer) : socket.write("x")), 20);
			socket.on("close", () => clearInterval(timer));
			return socket.write("* OK ");
		}
		send(
			options.greetingCapabilities === false
				? "* OK fake IMAP ready\r\n"
				: `* OK [CAPABILITY ${capabilities()}] ready\r\n`,
		);
	}

	const server = options.implicitTls
		? createTlsServer(options.tls, (socket) => handle(socket, true))
		: createNetServer((socket) => handle(socket, false));
	if (options.implicitTls) server.on("tlsClientError", () => undefined);
	await new Promise((resolve) => server.listen(0, options.host ?? "127.0.0.1", resolve));

	return {
		port: server.address().port,
		host: options.host ?? "127.0.0.1",
		commands,
		addMessage,
		/** Connections the server still holds open. */
		openConnections: () => connections.size,
		bumpUidValidity,
		failNextLogin() {
			nextLoginFails = true;
		},
		async close() {
			for (const socket of connections) socket.destroy();
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/** Up to 16 MB of a line without CRLF, a megabyte at a time, until the client goes away. */
function streamEndlessLine(socket) {
	const chunk = Buffer.alloc(1024 * 1024, "x");
	let sent = 0;
	const next = () => {
		while (!socket.destroyed && sent < 16) {
			sent += 1;
			if (!socket.write(sent === 1 ? Buffer.concat([Buffer.from("* OK "), chunk]) : chunk))
				return socket.once("drain", next);
		}
	};
	next();
}

/** Untagged lines of `lineBytes` each, up to 64 MB, until the client goes away; the tagged answer never comes. */
function streamUntaggedFlood(socket, lineBytes) {
	const line = `* OK ${"x".repeat(Math.max(lineBytes - 7, 0))}\r\n`;
	const chunk = Buffer.from(line.repeat(Math.max(1, Math.floor((256 * 1024) / line.length))));
	let sent = 0;
	const next = () => {
		while (!socket.destroyed && sent < 64 * 1024 * 1024) {
			sent += chunk.length;
			if (!socket.write(chunk)) return socket.once("drain", next);
		}
	};
	next();
}

/** The quoted (or atom) arguments of a command line, unescaped. */
function parseQuoted(args) {
	const values = [];
	const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
	let match;
	while ((match = pattern.exec(args)))
		values.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
	return values;
}

/**
 * A small RFC 5322 message with a unique Message-ID. `messageId: null` leaves the header out (and `date: null` the
 * Date header); `inReplyTo` and `references` add those headers.
 *
 * @param {number} index
 * @param {{ subject?: string, from?: string, messageId?: string | null, date?: string | null, inReplyTo?: string | null, references?: string | null }} [options]
 */
export function sampleMessage(
	index,
	{
		subject = `Fake IMAP message ${index}`,
		from = "sender@example.org",
		messageId = `<fake-imap-${index}-${Date.now()}@example.org>`,
		date = "Tue, 27 Oct 2026 10:00:00 +0000",
		inReplyTo = null,
		references = null,
	} = {},
) {
	return [
		`From: Sender <${from}>`,
		"To: user@example.test",
		`Subject: ${subject}`,
		...(messageId ? [`Message-ID: ${messageId}`] : []),
		...(date ? [`Date: ${date}`] : []),
		...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
		...(references ? [`References: ${references}`] : []),
		"Content-Type: text/plain; charset=utf-8",
		"",
		`Body of message ${index}.`,
		"",
	].join("\r\n");
}
