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
 * - `users`: `{ [username]: password }`.
 * - `folders`: `{ [name]: [raw message, …] }`; UIDs count up from 1 per folder.
 */
export async function startFakeImap(options = {}) {
	const users = options.users ?? { "user@example.test": "app-password" };
	const folders = new Map();
	const commands = [];
	const connections = new Set();
	let nextLoginFails = false;

	function addMessage(folder, raw) {
		if (!folders.has(folder)) folders.set(folder, { nextUid: 1, messages: [] });
		const entry = folders.get(folder);
		const uid = entry.nextUid++;
		entry.messages.push({ uid, raw: Buffer.from(raw) });
		return uid;
	}
	if (!options.folders) addMessage("INBOX", sampleMessage(1));
	for (const [name, messages] of Object.entries(options.folders ?? {})) {
		if (!folders.has(name)) folders.set(name, { nextUid: 1, messages: [] });
		for (const raw of messages) addMessage(name, raw);
	}

	function handle(socket, encrypted) {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => undefined);
		const state = { socket, encrypted, authenticated: false, selected: null, pendingAuth: null, buffer: "" };

		const capabilities = () => {
			const list = ["IMAP4rev1"];
			if (!state.encrypted && options.starttls) list.push("STARTTLS");
			if (!state.encrypted && options.loginDisabledWithoutTls) list.push("LOGINDISABLED");
			if (options.authPlain) list.push("AUTH=PLAIN");
			if (options.saslIr) list.push("SASL-IR");
			return list.join(" ");
		};
		const send = (text) => state.socket.write(text);

		const onData = (chunk) => {
			state.buffer += chunk.toString("utf8");
			let index;
			while ((index = state.buffer.indexOf("\r\n")) >= 0) {
				const line = state.buffer.slice(0, index);
				state.buffer = state.buffer.slice(index + 2);
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
				state.pendingAuth = null;
				plain(tag, line.trim());
				return;
			}
			const [tag, rawName, ...rest] = line.split(" ");
			const name = (rawName ?? "").toUpperCase();
			const args = rest.join(" ");
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
				const secure = new TLSSocket(state.socket, { isServer: true, ...options.tls });
				secure.on("error", () => undefined);
				connections.add(secure);
				secure.on("close", () => connections.delete(secure));
				state.socket = secure;
				state.encrypted = true;
				state.buffer = "";
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
			if (name === "LIST") {
				const lines = [...folders.keys()].map((folder) => `* LIST (\\HasNoChildren) "/" "${folder}"\r\n`);
				return send(`${lines.join("")}${tag} OK done\r\n`);
			}
			if (name === "SELECT" || name === "EXAMINE") {
				const [folder] = parseQuoted(args);
				const entry = folders.get(folder);
				if (!entry) return send(`${tag} NO [NONEXISTENT] No such folder\r\n`);
				state.selected = folder;
				return send(
					`* ${entry.messages.length} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${entry.nextUid}] ok\r\n${tag} OK [READ-ONLY] done\r\n`,
				);
			}
			const entry = state.selected ? folders.get(state.selected) : null;
			if (name === "UID" && entry) {
				const [sub, set] = args.split(" ");
				if (sub.toUpperCase() === "SEARCH")
					return send(`* SEARCH ${entry.messages.map((message) => message.uid).join(" ")}\r\n${tag} OK done\r\n`);
				if (sub.toUpperCase() === "FETCH") {
					const wanted = new Set(set.split(",").map(Number));
					entry.messages.forEach((message, index) => {
						if (!wanted.has(message.uid)) return;
						send(`* ${index + 1} FETCH (UID ${message.uid} BODY[] {${message.raw.length}}\r\n`);
						send(message.raw);
						send(")\r\n");
					});
					return send(`${tag} OK done\r\n`);
				}
			}
			return send(`${tag} BAD unknown command\r\n`);
		}

		state.socket.on("data", onData);
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
		failNextLogin() {
			nextLoginFails = true;
		},
		async close() {
			for (const socket of connections) socket.destroy();
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
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

/** A small RFC 5322 message with a unique Message-ID. */
export function sampleMessage(index, { subject = `Fake IMAP message ${index}`, from = "sender@example.org" } = {}) {
	return [
		`From: Sender <${from}>`,
		"To: user@example.test",
		`Subject: ${subject}`,
		`Message-ID: <fake-imap-${index}-${Date.now()}@example.org>`,
		"Date: Tue, 27 Oct 2026 10:00:00 +0000",
		"Content-Type: text/plain; charset=utf-8",
		"",
		`Body of message ${index}.`,
		"",
	].join("\r\n");
}
