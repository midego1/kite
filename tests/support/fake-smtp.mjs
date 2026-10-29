import { connect as netConnect, createServer as createNetServer } from "node:net";
import { SMTPServer } from "smtp-server";

/**
 * A small SMTP submission server for tests, on the `smtp-server` dependency: implicit TLS (port 465 style) or
 * STARTTLS (587 style) with a throwaway certificate, `AUTH PLAIN` and `AUTH LOGIN`, and every accepted message recorded
 * with its envelope and bytes. A recording proxy sits in front of it, so tests can check that no credential ever
 * crossed the wire in plain text, and so it can misbehave in ways `smtp-server` never would. Never point it at, or copy
 * it from, a real provider.
 *
 * Options:
 * - `tls`: `{ cert, key }` (from `test-certificate.mjs`); required for `implicitTls` and `starttls`.
 * - `implicitTls`: the whole connection is TLS. `starttls` (default with `tls` and without `implicitTls`): offer it.
 *   Without either the server is plain text and accepts sign-in anyway (the e2e fake on loopback).
 * - `authMethods` (default `["PLAIN", "LOGIN"]`), `users` (`{ [username]: password }`), `size` (announced SIZE),
 *   `hide8BitMime` (do not announce 8BITMIME).
 * - `rejectRecipients`: `{ [address]: [code, text] }`, the answer to RCPT TO for that address.
 * - `rcptGate`: a function returning a promise; every RCPT TO is answered only once it resolves.
 * - `afterData`: what happens once a message has been received and recorded (it is queued, as far as the server
 *   knows): `"drop"` closes the connection instead of answering, `"hang"` never answers.
 * - Misbehaviour (answered by the proxy itself): `injectAfterStartTls` (bytes sent right behind the 220 to STARTTLS,
 *   before the handshake), `silent` (no greeting at all), `slowLoris` (a greeting trickled one byte at a time,
 *   forever), `endlessLine` (a greeting line that never ends), `garbage` (a greeting that is not an SMTP reply).
 *
 * `failNext(stage, code, text)` answers the next `auth`, `mail`, `rcpt` or `data` step with that reply.
 */
export async function startFakeSmtp(options = {}) {
	const users = options.users ?? { "user@example.test": "app-password" };
	const messages = [];
	const auths = [];
	const wire = [];
	const failures = new Map();
	const sockets = new Set();
	const starttls = !options.implicitTls && (options.starttls ?? !!options.tls);

	const failure = (stage) => {
		const next = failures.get(stage);
		if (!next) return null;
		failures.delete(stage);
		return Object.assign(new Error(next.text), { responseCode: next.code });
	};

	const smtp = new SMTPServer({
		secure: !!options.implicitTls,
		...(options.tls ?? {}),
		authMethods: options.authMethods ?? ["PLAIN", "LOGIN"],
		allowInsecureAuth: !options.tls,
		hideSTARTTLS: !starttls,
		hide8BITMIME: !!options.hide8BitMime,
		// `smtp-server` falls back to its default mechanisms for an empty list, so no AUTH at all is a disabled command.
		disabledCommands: [...(starttls ? [] : ["STARTTLS"]), ...(options.authMethods?.length === 0 ? ["AUTH"] : [])],
		...(options.size ? { size: options.size } : {}),
		disableReverseLookup: true,
		logger: false,
		banner: "fake SMTP ready",
		onAuth(auth, session, callback) {
			auths.push({ method: auth.method, username: auth.username, secure: !!session.secure });
			const injected = failure("auth");
			if (injected) return callback(injected);
			if (users[auth.username] !== auth.password)
				return callback(Object.assign(new Error("5.7.8 Username and Password not accepted"), { responseCode: 535 }));
			callback(null, { user: auth.username });
		},
		onMailFrom(_address, _session, callback) {
			callback(failure("mail") ?? undefined);
		},
		onRcptTo(address, _session, callback) {
			const answer = () => {
				const rejected = options.rejectRecipients?.[address.address];
				if (rejected) return callback(Object.assign(new Error(rejected[1]), { responseCode: rejected[0] }));
				callback(failure("rcpt") ?? undefined);
			};
			if (options.rcptGate) return void Promise.resolve(options.rcptGate()).then(answer);
			answer();
		},
		onData(stream, session, callback) {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => {
				if (stream.sizeExceeded) return callback();
				const injected = failure("data");
				if (injected) return callback(injected);
				messages.push({
					from: session.envelope.mailFrom.address,
					recipients: session.envelope.rcptTo.map((recipient) => recipient.address),
					mailParams: session.envelope.mailFrom.args || {},
					raw: Buffer.concat(chunks),
					secure: !!session.secure,
					user: session.user,
				});
				if (options.afterData === "hang") return;
				if (options.afterData === "drop") {
					for (const socket of sockets) socket.destroy();
					return;
				}
				callback(null, "2.0.0 OK queued as fake-1");
			});
		},
	});
	smtp.on("error", () => undefined);
	await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
	const upstreamPort = smtp.server.address().port;

	const proxy = createNetServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => undefined);
		if (misbehave(client, options)) return;
		const upstream = netConnect({ host: "127.0.0.1", port: upstreamPort });
		sockets.add(upstream);
		upstream.on("close", () => {
			sockets.delete(upstream);
			client.destroy();
		});
		upstream.on("error", () => client.destroy());
		client.on("close", () => upstream.destroy());
		let startTlsAsked = false;
		client.on("data", (chunk) => {
			wire.push(Buffer.from(chunk));
			if (/^STARTTLS\r\n/im.test(chunk.toString("latin1"))) startTlsAsked = true;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk) => {
			if (startTlsAsked && options.injectAfterStartTls && /^220 /m.test(chunk.toString("latin1"))) {
				startTlsAsked = false;
				client.write(Buffer.concat([chunk, Buffer.from(options.injectAfterStartTls)]));
				return;
			}
			client.write(chunk);
		});
	});
	await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

	return {
		port: proxy.address().port,
		host: "127.0.0.1",
		messages,
		auths,
		/** Every byte the client sent, as it crossed the wire (ciphertext once TLS is up). */
		wire: () => Buffer.concat(wire),
		failNext(stage, code, text) {
			failures.set(stage, { code, text });
		},
		/** Connections the proxy still holds open. */
		openConnections: () => sockets.size,
		/** Breaks every open connection, as a network failure would; the server keeps listening. */
		dropConnections() {
			for (const socket of sockets) socket.destroy();
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await Promise.all([
				new Promise((resolve) => proxy.close(() => resolve())),
				new Promise((resolve) => smtp.close(() => resolve())),
			]);
		},
	};
}

/** Answers the connection itself when the test asked for a broken server; true when it did. */
function misbehave(client, options) {
	if (options.silent) return true;
	if (options.garbage) {
		client.write("HTTP/1.1 400 Bad Request\r\n");
		return true;
	}
	if (options.slowLoris) {
		const timer = setInterval(() => (client.destroyed ? clearInterval(timer) : client.write("2")), 20);
		client.on("close", () => clearInterval(timer));
		return true;
	}
	if (options.endlessLine) {
		const chunk = Buffer.alloc(64 * 1024, "x");
		let sent = 0;
		const next = () => {
			while (!client.destroyed && sent < 64) {
				sent += 1;
				if (!client.write(sent === 1 ? Buffer.concat([Buffer.from("220 "), chunk]) : chunk))
					return client.once("drain", next);
			}
		};
		next();
		return true;
	}
	return false;
}

/** A small message with CRLF line endings, a unique Message-ID and `lines` as its body. */
export function sampleSmtpMessage({ from = "user@example.test", to = "friend@example.org", lines = ["Hello."] } = {}) {
	return Buffer.from(
		[
			`From: ${from}`,
			`To: ${to}`,
			"Subject: Fake SMTP message",
			`Message-ID: <fake-smtp-${Date.now()}@example.test>`,
			"Date: Thu, 29 Oct 2026 10:00:00 +0000",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			...lines,
			"",
		].join("\r\n"),
	);
}
