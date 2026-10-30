import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { dkimSign } from "mailauth";
import { bundleModules, root } from "./support/modules-bundle.mjs";

// Invented mail only. The self-hosted SMTP listener (upstream Mailflare #215): session, recipient and size limits,
// SPF/DKIM/DMARC verified with mailauth into an Authentication-Results value under Kite's own authserv-id, and a
// trusted Received field. DNS is a fake resolver throughout, so nothing leaves the machine.

const {
	SMTP_INGRESS_LIMITS,
	createSessionLimiter,
	createDataCollector,
	authenticationResultsFromMailauth,
	verifySmtpAuthentication,
	smtpAuthservId,
	trustedReceivedHeader,
	startSmtpListener,
	analyzeAuthentication,
	publishedDmarcPolicy,
	SqliteDatabase,
	applyMigrations,
} = await bundleModules("kite-smtp-ingress-", [
	["SMTP_INGRESS_LIMITS, createSessionLimiter, createDataCollector", "server/runtime/smtp-limits-utils.ts"],
	["verifySmtpAuthentication", "server/runtime/smtp-auth.ts"],
	["authenticationResultsFromMailauth, smtpAuthservId, trustedReceivedHeader", "server/runtime/smtp-auth-utils.ts"],
	["startSmtpListener", "server/runtime/smtp.ts"],
	["analyzeAuthentication", "src/lib/spam/analyzers/authentication.ts"],
	["publishedDmarcPolicy", "src/lib/spam/dmarc-policy-utils.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
]);

const ids = (signals) => signals.map((signal) => signal.id).sort();

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RECORDS = {
	"s1._domainkey.bank.test:TXT": [
		[`v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`],
	],
	"bank.test:TXT": [["v=spf1 ip4:192.0.2.1 ip4:127.0.0.1 -all"]],
	"_dmarc.bank.test:TXT": [["v=DMARC1; p=reject"]],
};
async function resolver(name, type) {
	const answer = RECORDS[`${name.toLowerCase()}:${type}`];
	if (answer) return answer;
	throw Object.assign(new Error(`${name} not found`), { code: "ENOTFOUND" });
}

const MESSAGE = [
	"From: Bank <security@bank.test>",
	"To: owner@example.com",
	"Subject: Statement",
	"Message-ID: <statement@bank.test>",
	"Date: Thu, 30 Oct 2026 10:00:00 +0000",
	"",
	"Your statement is ready.",
	"",
].join("\r\n");

async function signed(message = MESSAGE) {
	const result = await dkimSign(message, {
		signatureData: [
			{ signingDomain: "bank.test", selector: "s1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) },
		],
	});
	return Buffer.from(result.signatures + message);
}

test("SMTP ingress limits", () => {
	assert.deepEqual(SMTP_INGRESS_LIMITS, {
		maxClients: 100,
		maxSessionsPerIp: 10,
		maxRecipients: 50,
		socketTimeoutMs: 60_000,
	});
});

test("the session limiter counts only admitted sessions", () => {
	const limiter = createSessionLimiter({ maxClients: 4, maxSessionsPerIp: 2 });
	assert.equal(limiter.admit("a1", "192.0.2.1"), true);
	assert.equal(limiter.admit("a2", "192.0.2.1"), true);
	assert.equal(limiter.admit("a3", "192.0.2.1"), false, "third session from one address");
	// The refused session closing must not free a slot.
	limiter.release("a3");
	assert.equal(limiter.sessionsFrom("192.0.2.1"), 2);
	assert.equal(limiter.admit("a4", "192.0.2.1"), false);
	assert.equal(limiter.admit("b1", "192.0.2.2"), true);
	assert.equal(limiter.admit("b2", "192.0.2.2"), true);
	assert.equal(limiter.admit("c1", "192.0.2.3"), false, "server full");
	assert.equal(limiter.size, 4);
	limiter.release("a1");
	limiter.release("a1");
	assert.equal(limiter.sessionsFrom("192.0.2.1"), 1);
	assert.equal(limiter.admit("c1", "192.0.2.3"), true);
	assert.equal(limiter.admit("c1", "192.0.2.3"), true, "admitting twice is idempotent");
	assert.equal(limiter.size, 4);
	for (const id of ["a2", "b1", "b2", "c1"]) limiter.release(id);
	assert.equal(limiter.size, 0);
	assert.equal(limiter.sessionsFrom("192.0.2.1"), 0);
});

test("the DATA collector stops buffering past the size limit", () => {
	const data = createDataCollector(10);
	data.push(Buffer.from("12345"));
	data.push(Buffer.from("67890"));
	assert.equal(data.exceeded, false);
	assert.equal(data.buffer().toString(), "1234567890");
	data.push(Buffer.from("x"));
	assert.equal(data.exceeded, true);
	assert.equal(data.received, 11);
	assert.equal(data.buffer().length, 0, "nothing is held once over");
	data.push(Buffer.alloc(1024));
	assert.equal(data.buffer().length, 0);
});

test("mailauth's verdict becomes an Authentication-Results value Kite reads like Cloudflare's", async () => {
	const pass = await verifySmtpAuthentication(
		await signed(),
		{ ip: "192.0.2.1", helo: "mta.bank.test", sender: "bounce@bank.test", authservId: "mx.kite.test" },
		{ resolver },
	);
	assert.equal(
		pass,
		"mx.kite.test; spf=pass smtp.mailfrom=bounce@bank.test; dkim=pass header.d=bank.test header.s=s1; dmarc=pass header.from=bank.test policy.dmarc=reject",
	);
	const passSignals = analyzeAuthentication(pass, "bank.test");
	assert.deepEqual(ids(passSignals), ["dkim_passed", "dmarc_passed", "spf_passed"]);
	assert.equal(passSignals.find((signal) => signal.id === "dkim_passed").metadata.aligned, true);

	// From another address and unsigned: a spoof of a p=reject domain.
	const spoof = await verifySmtpAuthentication(
		Buffer.from(MESSAGE),
		{ ip: "198.51.100.7", helo: "mta.bank.test", sender: "bounce@bank.test", authservId: "mx.kite.test" },
		{ resolver },
	);
	assert.equal(
		spoof,
		"mx.kite.test; spf=fail smtp.mailfrom=bounce@bank.test; dkim=none; dmarc=fail header.from=bank.test policy.dmarc=reject",
	);
	assert.deepEqual(ids(analyzeAuthentication(spoof, "bank.test")), ["dmarc_failed", "spf_failed"]);
	assert.equal(publishedDmarcPolicy(spoof), "reject");

	// A tampered body breaks the signature.
	const tampered = Buffer.from((await signed()).toString().replace("ready", "late"));
	const broken = await verifySmtpAuthentication(
		tampered,
		{ ip: "192.0.2.1", helo: "mta.bank.test", sender: "bounce@bank.test", authservId: "mx.kite.test" },
		{ resolver },
	);
	assert.match(broken, /dkim=(fail|neutral) header\.d=bank\.test/);
});

test("verification that fails or takes too long leaves authentication unknown", async () => {
	const slow = () => new Promise(() => {});
	const started = Date.now();
	const value = await verifySmtpAuthentication(
		Buffer.from(MESSAGE),
		{ ip: "192.0.2.1", sender: "bounce@bank.test", authservId: "mx.kite.test" },
		{ resolver: slow, timeoutMs: 100 },
	);
	assert.equal(value, null);
	assert.ok(Date.now() - started < 5000);
});

test("sender-chosen text never shapes the header", () => {
	const result = {
		spf: { status: { result: "pass", smtp: { mailfrom: '"x; dmarc=pass"@bank.test', helo: "a (b)" } } },
		dkim: { results: [{ status: { result: "pass" }, signingDomain: "bank.test; dmarc=pass", selector: "s1" }] },
		dmarc: { status: { result: "temperr", header: { from: "bank.test" } }, policy: "reject, dmarc=pass" },
	};
	assert.equal(
		authenticationResultsFromMailauth(result, "mx.kite.test"),
		"mx.kite.test; spf=pass; dkim=pass header.s=s1; dmarc=temperror header.from=bank.test",
	);
	assert.equal(authenticationResultsFromMailauth({ spf: false, dkim: undefined, dmarc: false }, "x"), null);
	assert.equal(
		authenticationResultsFromMailauth({ spf: { status: { result: "none", smtp: { helo: "mta.bank.test" } } } }, "k"),
		"k; spf=none smtp.helo=mta.bank.test",
	);
	assert.equal(smtpAuthservId("MX.Kite.Test"), "mx.kite.test");
	assert.notEqual(smtpAuthservId("bad; id"), "bad; id");

	const date = new Date(Date.UTC(2026, 9, 30, 10, 0, 0));
	assert.equal(
		trustedReceivedHeader({
			helo: "mta.bank.test",
			remoteAddress: "::ffff:192.0.2.1",
			clientHostname: "mta.bank.test",
			by: "mx.kite.test",
			secure: true,
			sessionId: "abc123",
			date,
		}),
		"Received: from mta.bank.test (mta.bank.test [192.0.2.1]) by mx.kite.test (Kite) with ESMTPS id abc123; Fri, 30 Oct 2026 10:00:00 +0000",
	);
	assert.equal(
		trustedReceivedHeader({
			helo: "evil\r\nAuthentication-Results: x",
			remoteAddress: "198.51.100.7",
			clientHostname: "[198.51.100.7]",
			by: "mx.kite.test",
			secure: false,
			sessionId: "s",
			date,
		}),
		"Received: from unknown ([198.51.100.7]) by mx.kite.test (Kite) with ESMTP id s; Fri, 30 Oct 2026 10:00:00 +0000",
	);
});

/** A line-based SMTP client: `send` writes one command and resolves with the complete reply. */
async function smtpClient(port) {
	const socket = connect(port, "127.0.0.1");
	socket.setEncoding("utf8");
	let buffer = "";
	const waiting = [];
	const replies = [];
	socket.on("data", (chunk) => {
		buffer += chunk;
		let match;
		while ((match = /^(\d{3}) .*\r?\n/m.exec(buffer))) {
			const end = match.index + match[0].length;
			const reply = { code: Number(match[1]), text: buffer.slice(0, end) };
			buffer = buffer.slice(end);
			const next = waiting.shift();
			if (next) next(reply);
			else replies.push(reply);
		}
	});
	socket.on("error", () => {});
	const read = () =>
		replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiting.push(resolve));
	const greeting = await read();
	return {
		greeting,
		read,
		send(line) {
			socket.write(`${line}\r\n`);
			return read();
		},
		write(data) {
			socket.write(data);
		},
		async close() {
			socket.end();
			if (!socket.destroyed) await once(socket, "close");
		},
	};
}

async function listener(t, { maxSize = 4096 } = {}) {
	const sqlite = new SqliteDatabase(":memory:");
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'owner', 1);
	`);
	const stored = new Map();
	const queued = [];
	const env = {
		DB: sqlite,
		BUCKET: { put: async (key, value) => stored.set(key, Buffer.from(value)) },
		INBOUND_QUEUE: { send: async (payload) => queued.push(payload) },
	};
	const mailer = { sendRaw: async () => true };
	const server = startSmtpListener(env, mailer, {
		port: 0,
		host: "127.0.0.1",
		maxSize,
		hostname: "mx.kite.test",
		tls: null,
		resolver,
	});
	await once(server.server, "listening");
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		sqlite.db.close();
	});
	return { port: server.server.address().port, stored, queued };
}

async function envelope(client, recipients = ["owner@example.com"]) {
	assert.equal((await client.send("EHLO mta.bank.test")).code, 250);
	assert.equal((await client.send("MAIL FROM:<bounce@bank.test>")).code, 250);
	for (const recipient of recipients) assert.equal((await client.send(`RCPT TO:<${recipient}>`)).code, 250);
}

test("the listener verifies the sender and stamps a trusted Received field", async (t) => {
	const { port, stored, queued } = await listener(t);
	const client = await smtpClient(port);
	await envelope(client);
	assert.equal((await client.send("DATA")).code, 354);
	// The sender's own Authentication-Results claims a pass that nobody verified.
	const forged = `Authentication-Results: mx.kite.test; dmarc=pass header.from=bank.test\r\n${(await signed()).toString()}`;
	client.write(`${forged.replace(/\r\n\./g, "\r\n..")}\r\n.\r\n`);
	assert.equal((await client.read()).code, 250);
	await client.close();

	assert.equal(queued.length, 1);
	const [payload] = queued;
	// 127.0.0.1 is in bank.test's SPF record and the signature is intact.
	assert.match(payload.authenticationResults, /^mx\.kite\.test; spf=pass smtp\.mailfrom=bounce@bank\.test; dkim=pass/);
	assert.match(payload.authenticationResults, /dmarc=pass header\.from=bank\.test policy\.dmarc=reject$/);
	assert.match(
		payload.headers.received,
		/^from mta\.bank\.test \(.*\[127\.0\.0\.1\]\) by mx\.kite\.test \(Kite\) with ESMTP id /,
	);
	const raw = stored.get(payload.rawR2Key).toString("latin1");
	assert.match(raw, /^Received: from mta\.bank\.test /);
	assert.ok(raw.includes("Authentication-Results: mx.kite.test; dmarc=pass"), "the sender's copy stays in the message");
});

test("the listener refuses the 51st recipient with 452", async (t) => {
	const { port, queued } = await listener(t);
	const client = await smtpClient(port);
	await envelope(
		client,
		Array.from({ length: 50 }, (_, index) => `owner+${index}@example.com`),
	);
	const refused = await client.send("RCPT TO:<owner+50@example.com>");
	assert.equal(refused.code, 452);
	assert.match(refused.text, /too many recipients/i);
	// Repeating an address already in the envelope is not a new recipient.
	assert.equal((await client.send("RCPT TO:<owner+3@example.com>")).code, 250);
	await client.send("QUIT");
	await client.close();
	assert.equal(queued.length, 0);
});

test("the listener answers 552 to oversized DATA and keeps nothing", async (t) => {
	const { port, stored, queued } = await listener(t, { maxSize: 2048 });
	const client = await smtpClient(port);
	await envelope(client);
	assert.equal((await client.send("DATA")).code, 354);
	const line = `${"x".repeat(76)}\r\n`;
	client.write(`Subject: big\r\n\r\n${line.repeat(400)}.\r\n`);
	const reply = await client.read();
	assert.equal(reply.code, 552);
	// The session goes on: a following message within the limit is accepted.
	assert.equal((await client.send("MAIL FROM:<bounce@bank.test>")).code, 250);
	assert.equal((await client.send("RCPT TO:<owner@example.com>")).code, 250);
	assert.equal((await client.send("DATA")).code, 354);
	client.write("Subject: small\r\n\r\nhello\r\n.\r\n");
	assert.equal((await client.read()).code, 250);
	await client.close();
	assert.equal(queued.length, 1);
	assert.equal(stored.size, 1);
});

test("the listener refuses an eleventh session from one address", async (t) => {
	const { port } = await listener(t);
	const clients = [];
	for (let index = 0; index < 10; index += 1) {
		const client = await smtpClient(port);
		assert.equal(client.greeting.code, 220);
		clients.push(client);
	}
	const extra = await smtpClient(port);
	assert.equal(extra.greeting.code, 421);
	await extra.close();
	// Closing an admitted session frees its slot; the refused one never held one.
	await clients.pop().close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const again = await smtpClient(port);
	assert.equal(again.greeting.code, 220);
	clients.push(again);
	for (const client of clients) await client.close();
});
