import assert from "node:assert/strict";
import test from "node:test";
import { startFakeSmtp, sampleSmtpMessage } from "./support/fake-smtp.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// The SMTP client through the Node server's connector (`server/runtime/tcp-connect.ts`) against the fake SMTP server:
// implicit TLS and STARTTLS with a throwaway certificate, AUTH PLAIN and LOGIN, the plain-text refusal, dot-stuffing on
// the wire, reply errors, and a message from the MIME builder delivered intact. This is the Node runtime's coverage.

const {
	createTcpConnect,
	openSmtpSession,
	submitMessage,
	SmtpReplyError,
	SmtpMessageTooLargeError,
	MailServerRefusedError,
	buildMimeMessage,
	parseRawMime,
} = await bundleModules("kite-smtp-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["openSmtpSession, submitMessage", "src/lib/smtp/session.ts"],
	["SmtpReplyError, SmtpMessageTooLargeError", "src/lib/smtp/errors.ts"],
	["MailServerRefusedError", "src/lib/net/errors.ts"],
	["buildMimeMessage", "src/lib/email/mime-build-utils.ts"],
	["parseRawMime", "src/lib/email/parse.ts"],
]);

const HOST = "smtp.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const tls = createTestCertificate([HOST]);

/** The connector as the Node server builds it, resolving the test host to loopback and trusting the test certificate. */
function nodeEnv(fake, { ca = tls.cert, resolve = async () => ["127.0.0.1"], connectTimeoutMs, ...env } = {}) {
	const connect = createTcpConnect({ ca: ca ?? undefined, resolve, allowLoopback: true, connectTimeoutMs });
	return {
		KITE_RUNTIME: "node",
		TCP_CONNECT: (address, options) => connect({ ...address, port: fake.port }, options),
		...env,
	};
}

const login = (overrides = {}) => ({
	host: HOST,
	port: 465,
	security: "tls",
	username: USER,
	password: PASSWORD,
	...overrides,
});

const envelope = { from: USER, recipients: ["friend@example.org"] };

async function fake(t, options) {
	const server = await startFakeSmtp({ tls, ...options });
	t.after(() => server.close());
	return server;
}

/** True when the password, or a SASL token carrying it, crossed the wire unencrypted. */
function secretSentInPlainText(server) {
	const wire = server.wire().toString("latin1");
	const forms = [
		PASSWORD,
		Buffer.from(PASSWORD).toString("base64"),
		Buffer.from(`\0${USER}\0${PASSWORD}`).toString("base64"),
	];
	return forms.some((form) => wire.includes(form));
}

test("implicit TLS: verifies the certificate, signs in with AUTH PLAIN and delivers the message", async (t) => {
	const server = await fake(t, { implicitTls: true });
	const result = await submitMessage(nodeEnv(server), login(), envelope, sampleSmtpMessage());
	assert.match(result.response, /OK queued as fake-1/);
	assert.equal(server.messages.length, 1);
	const [message] = server.messages;
	assert.equal(message.from, USER);
	assert.deepEqual(message.recipients, ["friend@example.org"]);
	assert.equal(message.secure, true);
	assert.match(message.raw.toString(), /Subject: Fake SMTP message/);
	assert.deepEqual(server.auths, [{ method: "PLAIN", username: USER, secure: true }]);
	assert.equal(secretSentInPlainText(server), false);
});

test("STARTTLS: upgrades before signing in, asks EHLO again and only then sends the password", async (t) => {
	const server = await fake(t, { starttls: true, authMethods: ["LOGIN"] });
	const session = await openSmtpSession(nodeEnv(server), login({ port: 587, security: "starttls" }));
	try {
		assert.ok(session.extensions.auth.includes("LOGIN"));
		assert.ok(!session.extensions.keywords.includes("STARTTLS"), "the EHLO after the upgrade replaces the first one");
		await session.send(envelope, sampleSmtpMessage());
	} finally {
		await session.close();
	}
	assert.deepEqual(server.auths, [{ method: "LOGIN", username: USER, secure: true }]);
	assert.equal(server.messages[0].secure, true);
	const plain = server.wire().toString("latin1");
	assert.match(plain, /^EHLO \[127\.0\.0\.1\]\r\nSTARTTLS\r\n/, "only EHLO and STARTTLS go out before the handshake");
	assert.equal(secretSentInPlainText(server), false);
});

test("a server without STARTTLS is refused before any credential is sent", async (t) => {
	const server = await fake(t, { starttls: false });
	await assert.rejects(
		openSmtpSession(nodeEnv(server), login({ port: 587, security: "starttls" })),
		(error) => error instanceof MailServerRefusedError && /does not offer STARTTLS.*port 465/.test(error.message),
	);
	assert.deepEqual(server.auths, []);
	assert.equal(secretSentInPlainText(server), false);
});

test("bytes injected behind the STARTTLS answer end the connection", async (t) => {
	const server = await fake(t, { starttls: true, injectAfterStartTls: "250 AUTH PLAIN\r\n" });
	await assert.rejects(
		openSmtpSession(nodeEnv(server), login({ port: 587, security: "starttls" })),
		(error) => error instanceof MailServerRefusedError && /before the TLS handshake/.test(error.message),
	);
	assert.equal(secretSentInPlainText(server), false);
});

test("certificates are always verified, for implicit TLS and for STARTTLS", async (t) => {
	const server = await fake(t, { implicitTls: true });
	await assert.rejects(openSmtpSession(nodeEnv(server, { ca: null }), login()), /Could not connect.*certificate/i);
	const other = createTestCertificate(["other.kite.test"]);
	await assert.rejects(openSmtpSession(nodeEnv(server, { ca: other.cert }), login()), /Could not connect/);
	const starttls = await fake(t, { starttls: true });
	await assert.rejects(
		openSmtpSession(nodeEnv(starttls, { ca: null }), login({ port: 587, security: "starttls" })),
		/TLS handshake with the SMTP server failed/,
	);
	assert.equal(secretSentInPlainText(starttls), false);
});

test("a wrong password is a 535 sign-in failure that marks the credentials, and never echoes them", async (t) => {
	const server = await fake(t, { implicitTls: true });
	await assert.rejects(openSmtpSession(nodeEnv(server), login({ password: "wrong-password" })), (error) => {
		assert.ok(error instanceof SmtpReplyError);
		assert.equal(error.stage, "auth");
		assert.equal(error.code, 535);
		assert.equal(error.authFailed, true);
		assert.equal(error.temporary, false);
		assert.match(error.message, /^SMTP sign-in failed: 535 5\.7\.8 Username and Password not accepted$/);
		assert.ok(!error.message.includes("wrong-password"));
		return true;
	});
});

test("a server echoing the credentials in its refusal has them redacted", async (t) => {
	const server = await fake(t, { implicitTls: true });
	server.failNext("auth", 535, `Rejected ${PASSWORD} for ${Buffer.from(`\0${USER}\0${PASSWORD}`).toString("base64")}`);
	await assert.rejects(openSmtpSession(nodeEnv(server), login()), (error) => {
		assert.ok(!error.message.includes(PASSWORD));
		assert.match(error.message, /Rejected \[redacted\] for \[redacted\]/);
		return true;
	});
});

test("a server that takes no password is refused", async (t) => {
	const server = await fake(t, { implicitTls: true, authMethods: [] });
	await assert.rejects(
		openSmtpSession(nodeEnv(server), login()),
		(error) => error instanceof MailServerRefusedError && /does not accept a password sign-in/.test(error.message),
	);
});

test("dot-stuffing: lines starting with a dot, and an embedded end-of-data marker, arrive unchanged", async (t) => {
	const server = await fake(t, { implicitTls: true });
	const lines = [".", "..two dots", ".leading dot", "middle . dot", "", "."];
	await submitMessage(nodeEnv(server), login(), envelope, sampleSmtpMessage({ lines }));
	const body = server.messages[0].raw.toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
	assert.equal(body, `${lines.join("\r\n")}\r\n`);
	// A bare LF never reaches the server, so `\n.\n` cannot end the data early (SMTP smuggling).
	const smuggled = Buffer.from("Subject: x\r\n\r\nbefore\n.\nMAIL FROM:<evil@example.org>\r\nafter");
	await submitMessage(nodeEnv(server), login(), envelope, smuggled);
	assert.equal(server.messages.length, 2);
	assert.equal(
		server.messages[1].raw.toString(),
		"Subject: x\r\n\r\nbefore\r\n.\r\nMAIL FROM:<evil@example.org>\r\nafter\r\n",
	);
});

test("Bcc recipients are in the envelope; duplicates are sent once; SIZE and 8BITMIME are declared", async (t) => {
	const server = await fake(t, { implicitTls: true, size: 1024 * 1024 });
	const raw = Buffer.from("Subject: caf\xc3\xa9\r\n\r\nBody\r\n", "latin1");
	await submitMessage(
		nodeEnv(server),
		login(),
		{ from: `Me <${USER}>`, recipients: ["a@example.org", "b@example.org", "A@example.org", "bcc@example.org"] },
		raw,
	);
	const [message] = server.messages;
	assert.deepEqual(message.recipients, ["a@example.org", "b@example.org", "bcc@example.org"]);
	assert.equal(message.mailParams.SIZE, String(raw.length));
	assert.equal(message.mailParams.BODY, "8BITMIME");
});

test("a message over the announced SIZE is refused before MAIL FROM", async (t) => {
	const server = await fake(t, { implicitTls: true, size: 100 });
	const session = await openSmtpSession(nodeEnv(server), login());
	try {
		await assert.rejects(session.send(envelope, Buffer.alloc(200, "a")), (error) => {
			assert.ok(error instanceof SmtpMessageTooLargeError);
			assert.equal(error.limitBytes, 100);
			return true;
		});
		await session.send(envelope, Buffer.from("Subject: small\r\n\r\nok\r\n"));
	} finally {
		await session.close();
	}
	assert.equal(server.messages.length, 1);
});

test("a refused recipient fails the whole message after RSET, and the session stays usable", async (t) => {
	const server = await fake(t, {
		implicitTls: true,
		rejectRecipients: { "nobody@example.org": [550, "5.1.1 No such user"] },
	});
	const session = await openSmtpSession(nodeEnv(server), login());
	try {
		await assert.rejects(
			session.send({ from: USER, recipients: ["friend@example.org", "nobody@example.org"] }, sampleSmtpMessage()),
			(error) => {
				assert.ok(error instanceof SmtpReplyError);
				assert.equal(error.stage, "rcpt");
				assert.equal(error.enhancedCode, "5.1.1");
				assert.equal(error.message, "The SMTP server refused the recipient nobody@example.org: 550 5.1.1 No such user");
				return true;
			},
		);
		assert.equal(server.messages.length, 0);
		await session.send(envelope, sampleSmtpMessage());
	} finally {
		await session.close();
	}
	assert.equal(server.messages.length, 1);
});

test("4xx replies are temporary and 5xx permanent, at MAIL FROM and after the data", async (t) => {
	const server = await fake(t, { implicitTls: true });
	const session = await openSmtpSession(nodeEnv(server), login());
	try {
		server.failNext("mail", 451, "4.3.0 Try again later");
		await assert.rejects(session.send(envelope, sampleSmtpMessage()), (error) => {
			assert.equal(error.stage, "mail");
			assert.equal(error.temporary, true);
			assert.equal(error.authFailed, false);
			return true;
		});
		server.failNext("data", 554, "5.7.0 Message rejected as spam");
		await assert.rejects(session.send(envelope, sampleSmtpMessage()), (error) => {
			assert.equal(error.stage, "data");
			assert.equal(error.temporary, false);
			assert.equal(error.message, "The SMTP server refused the message: 554 5.7.0 Message rejected as spam");
			return true;
		});
		await session.send(envelope, sampleSmtpMessage());
	} finally {
		await session.close();
	}
	assert.equal(server.messages.length, 1);
});

test("addresses that could break a command are refused before anything is sent", async (t) => {
	const server = await fake(t, { implicitTls: true });
	const session = await openSmtpSession(nodeEnv(server), login());
	try {
		for (const recipients of [["a@example.org>\r\nRSET"], ["a b@example.org"], ["jörg@example.org"], []])
			await assert.rejects(session.send({ from: USER, recipients }, sampleSmtpMessage()));
		await assert.rejects(session.send({ from: "", recipients: ["a@example.org"] }, sampleSmtpMessage()));
	} finally {
		await session.close();
	}
	assert.equal(server.messages.length, 0);
	await assert.rejects(openSmtpSession(nodeEnv(server), login({ password: "pass\r\nRSET" })), /line break/);
});

test("an internationalized domain goes out in its ASCII form", async (t) => {
	// Plain text under the dev flag, so the test can read the command on the wire.
	const server = await startFakeSmtp();
	t.after(() => server.close());
	const env = {
		KITE_RUNTIME: "node",
		EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1",
		TCP_CONNECT: createTcpConnect({ allowLoopback: true }),
	};
	const target = login({ host: "127.0.0.1", port: server.port, security: "starttls" });
	await submitMessage(env, target, { from: USER, recipients: ["info@Bücher.example"] }, sampleSmtpMessage());
	assert.match(server.wire().toString(), /\r\nRCPT TO:<info@xn--bcher-kva\.example>\r\n/);
});

test("a message from the MIME builder arrives byte for byte and parses back", async (t) => {
	const server = await fake(t, { starttls: true });
	const built = buildMimeMessage({
		from: `"Jörg Müller" <${USER}>`,
		to: ["Friend <friend@example.org>"],
		bcc: ["hidden@example.org"],
		subject: "Grüße aus Köln — a subject long enough to need folding across more than one header line",
		text: "Hallo,\n.\nzwei Zeilen mit Umlauten: äöü.",
		html: "<p>Hallo, <b>Welt</b> ✓</p>",
		attachments: [
			{
				filename: "bericht.txt",
				type: "text/plain",
				content: new TextEncoder().encode("Inhalt\r\n.\r\nEnde").buffer,
				disposition: "attachment",
			},
		],
	});
	await submitMessage(
		nodeEnv(server),
		login({ port: 587, security: "starttls" }),
		{ from: USER, recipients: ["friend@example.org", "hidden@example.org"] },
		built.raw,
	);
	const [message] = server.messages;
	assert.deepEqual(message.recipients, ["friend@example.org", "hidden@example.org"]);
	assert.ok(Buffer.from(built.raw).equals(message.raw), "the server got exactly the built bytes");
	assert.ok(!message.raw.toString().includes("hidden@example.org"), "Bcc is in the envelope only");
	const parsed = await parseRawMime(
		message.raw.buffer.slice(message.raw.byteOffset, message.raw.byteOffset + message.raw.length),
	);
	assert.equal(
		parsed.subject,
		"Grüße aus Köln — a subject long enough to need folding across more than one header line",
	);
	// postal-mime hands text back with LF line endings and the line break before the boundary.
	assert.equal(parsed.text, "Hallo,\n.\nzwei Zeilen mit Umlauten: äöü.\n");
	assert.equal(parsed.attachments[0].filename, "bericht.txt");
	assert.equal(parsed.messageId, built.messageId);
});

test("the guard refuses local hosts and ports other than 465 and 587 before connecting", async () => {
	let connected = false;
	const env = {
		KITE_RUNTIME: "node",
		TCP_CONNECT: () => {
			connected = true;
			throw new Error("must not connect");
		},
	};
	await assert.rejects(openSmtpSession(env, login({ port: 25 })), /Port 25 is not allowed.*465 or 587/);
	await assert.rejects(openSmtpSession(env, login({ port: 993 })), /Port 993 is not allowed/);
	for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "mail.internal", "mailserver"])
		await assert.rejects(openSmtpSession(env, login({ host })), MailServerRefusedError, host);
	assert.equal(connected, false);
});

test("the connector pins vetted addresses: a name with any private address is refused", async (t) => {
	const server = await fake(t, { implicitTls: true });
	await assert.rejects(
		openSmtpSession(nodeEnv(server, { resolve: async () => ["93.184.216.34", "10.0.0.7"] }), login()),
		(error) => error instanceof MailServerRefusedError && /Private and local/.test(error.message),
	);
	assert.deepEqual(server.auths, []);
});

test("plain text works only to a loopback fake under the dev flag, outside production", async (t) => {
	const server = await startFakeSmtp();
	t.after(() => server.close());
	const env = {
		KITE_RUNTIME: "node",
		EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1",
		TCP_CONNECT: createTcpConnect({ allowLoopback: true }),
	};
	const target = login({ host: "127.0.0.1", port: server.port, security: "starttls" });
	await submitMessage(env, target, envelope, sampleSmtpMessage());
	assert.equal(server.messages.length, 1);

	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	t.after(() => {
		process.env.NODE_ENV = previous;
	});
	await assert.rejects(openSmtpSession(env, target), MailServerRefusedError);
});

test("a server that trickles, goes silent or sends no SMTP reply is dropped", async (t) => {
	for (const misbehaviour of [{ slowLoris: true }, { silent: true }]) {
		const server = await fake(t, misbehaviour);
		const started = Date.now();
		await assert.rejects(
			openSmtpSession(nodeEnv(server), login({ port: 587, security: "starttls" }), { commandTimeoutMs: 400 }),
			/The SMTP server did not answer in time/,
		);
		assert.ok(Date.now() - started < 5_000, "the deadline, not the idle timeout, ends it");
	}
	const endless = await fake(t, { endlessLine: true });
	await assert.rejects(
		openSmtpSession(nodeEnv(endless), login({ port: 587, security: "starttls" })),
		/The SMTP server sent a line longer than 16 KB/,
	);
	const garbage = await fake(t, { garbage: true });
	await assert.rejects(
		openSmtpSession(nodeEnv(garbage), login({ port: 587, security: "starttls" })),
		/a reply Kite does not understand/,
	);
});
