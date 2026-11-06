import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { sampleMessage, startFakeImap } from "./support/fake-imap.mjs";
import { root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Two-way sync of connected accounts (spec §6.8), through the real runs, the Node connector and the inbound pipeline
// against the fake IMAP server on SQLite: every setting both ways, nothing with the settings off, a move that is never
// an expunge, loops, last writer wins, UIDVALIDITY, pause, shared mailboxes and failures.

const stubAgentSchedule = {
	name: "stub-agent-schedule",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/agent\/auto-read\/schedule$/ }, (args) => ({
			path: args.path,
			namespace: "stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export async function scheduleAgentWork() {}",
			loader: "js",
		}));
	},
};

const outDir = makeBundleDirectory("kite-two-way-node-");
after(() => rmSync(outDir, { recursive: true, force: true }));
const exports = [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	["connectExternalAccount, updateExternalAccount", "src/lib/external-accounts/service.ts"],
	["syncExternalAccount, writebackExternalAccount", "src/lib/external-accounts/sync.ts"],
	["readTwoWayView, saveTwoWay", "src/lib/external-accounts/two-way.ts"],
	["recordKiteChange", "src/lib/external-accounts/two-way-record.ts"],
	["processInboundMessage", "src/lib/email/inbound.ts"],
	["permanentlyDeleteMessages", "src/lib/email/permanent-delete.ts"],
	["markMessageAsReadForUser, updateMessageStatusForUser", "src/lib/user.ts"],
	["getDb", "src/db/index.ts"],
	["exportDatabaseRecords", "src/lib/backups/export.ts"],
];
await build({
	stdin: {
		contents: exports.map(([names, file]) => `export { ${names} } from "./${file}";`).join("\n"),
		resolveDir: root,
		sourcefile: "two-way-test-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [stubAgentSchedule],
	logLevel: "silent",
});
const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	connectExternalAccount,
	updateExternalAccount,
	syncExternalAccount,
	writebackExternalAccount,
	readTwoWayView,
	saveTwoWay,
	recordKiteChange,
	processInboundMessage,
	permanentlyDeleteMessages,
	markMessageAsReadForUser,
	updateMessageStatusForUser,
	getDb,
	exportDatabaseRecords,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const HOST = "imap.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const tls = createTestCertificate([HOST]);
const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
const OFF = {
	kiteDelete: "nothing",
	kiteArchive: "nothing",
	kiteSpam: "nothing",
	kiteFlags: false,
	providerGone: "nothing",
	providerFlags: false,
};
const ALL_FOLDERS = {
	specialUse: true,
	move: true,
	uidplus: true,
	folderAttributes: { Trash: ["\\Trash"], Junk: ["\\Junk"], Archive: ["\\Archive"] },
};
const WRITES = /\b(STORE|COPY|MOVE|EXPUNGE|APPEND)\b|^\S+ SELECT /i;

const previousEnv = globalThis.__kiteNodeEnv;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
	globalThis.fetch = realFetch;
});
globalThis.fetch = async () => new Response("", { status: 404 });

function memoryBucket() {
	const objects = new Map();
	return {
		put: async (key, value) => {
			objects.set(key, Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value));
		},
		get: async (key) => {
			const body = objects.get(key);
			if (!body) return null;
			return {
				arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
				text: async () => body.toString("utf8"),
			};
		},
		head: async (key) => (objects.has(key) ? { key } : null),
		delete: async (keys) => {
			for (const key of [keys].flat()) objects.delete(key);
		},
	};
}

async function start(t, options = {}) {
	const server = await startFakeImap({
		tls,
		implicitTls: true,
		authPlain: true,
		saslIr: true,
		users: { [USER]: PASSWORD, "second@example.test": PASSWORD },
		folders: { INBOX: [], Trash: [], Junk: [], Archive: [] },
		...ALL_FOLDERS,
		...options,
	});
	t.after(() => server.close());
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'shared', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'b', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'other', 'full_access', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const inbound = [];
	const agent = [];
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		TCP_CONNECT: (address, connectOptions) => connect({ ...address, port: server.port }, connectOptions),
		DB: db,
		BUCKET: memoryBucket(),
		INBOUND_QUEUE: { send: async (message) => inbound.push(message) },
		OUTBOUND_QUEUE: { send: async () => undefined },
		AGENT_QUEUE: {
			send: async (message, options) => agent.push({ message, options }),
			sendBatch: async () => undefined,
		},
	};
	globalThis.__kiteNodeEnv = env;
	const account = await connectExternalAccount(env, owner, {
		address: USER,
		preset: "other",
		mailboxId: "mailbox-a",
		imap: { host: HOST, port: 993, security: "tls" },
		password: PASSWORD,
		kitePassword: KITE_PASSWORD,
	});
	const accountId = account.id;
	/** One regular check, then what it handed on delivered, as the consumers would. */
	const check = async () => {
		db.db.exec("UPDATE external_accounts SET next_sync_at = 0, lease_until = NULL, last_sync_at = NULL");
		const result = await syncExternalAccount(env, accountId);
		for (const message of inbound.splice(0)) await processInboundMessage(env, message);
		return result;
	};
	const setTwoWay = (patch) => saveTwoWay(env, owner, accountId, { ...OFF, ...patch });
	const message = (subject) => db.db.prepare("SELECT * FROM messages WHERE subject = ?").get(subject);
	const ref = (subject) =>
		db.db.prepare("SELECT * FROM external_message_refs WHERE message_id = ?").get(message(subject).id);
	const actions = () => db.db.prepare("SELECT * FROM external_provider_actions ORDER BY id").all();
	const problems = () =>
		JSON.parse(db.db.prepare("SELECT recent_errors FROM external_accounts").get().recent_errors).map(
			(entry) => entry.message,
		);
	const flagsAt = (folder, subject) =>
		server.listMessages(folder).find((entry) => entry.raw.includes(`Subject: ${subject}`))?.flags;
	const has = (folder, subject) => flagsAt(folder, subject) !== undefined;
	/** Delivers a new INBOX message into Kite and returns its UID at the provider. */
	const arrive = async (subject, flags = []) => {
		const uid = server.addMessage("INBOX", {
			raw: sampleMessage(Math.floor(Math.random() * 1e9), { subject, messageId: `<${subject}@example.org>` }),
			flags,
		});
		await check();
		assert.ok(message(subject), `${subject} arrived`);
		return uid;
	};
	return {
		server,
		db,
		env,
		agent,
		inboundOf: inbound,
		accountId,
		check,
		setTwoWay,
		message,
		ref,
		actions,
		problems,
		flagsAt,
		has,
		arrive,
	};
}

const session = { id: "owner", role: "user" };
const writes = (server) => server.commands.filter((command) => WRITES.test(command.line));

test("with every setting off nothing at the provider changes and nothing from it arrives after the first fetch", async (t) => {
	const { server, env, check, arrive, message, actions, accountId } = await start(t);
	const uid = await arrive("left alone");
	await updateMessageStatusForUser(env, session, message("left alone").id, "trash");
	await markMessageAsReadForUser(env, session, message("left alone").id);
	await recordKiteChange(env, [message("left alone").id], { kind: "flags", starred: true });
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(actions(), []);
	server.setFlags("INBOX", uid, ["\\Flagged"]);
	await check();
	assert.deepEqual(writes(server), []);
	assert.equal(message("left alone").starred, 0);
	await updateMessageStatusForUser(env, session, message("left alone").id, "received");
	server.removeMessage("INBOX", uid);
	await check();
	assert.equal(message("left alone").status, "received");
	assert.deepEqual(writes(server), []);
});

test("delete in Kite moves the message to the provider's Trash: a MOVE, never an expunge, and it does not come back", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, ref, actions, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash", providerGone: "trash" });
	await arrive("to the trash");
	await check();
	assert.equal(await updateMessageStatusForUser(env, session, message("to the trash").id, "trash"), true);
	assert.equal(actions().length, 1);
	assert.equal(actions()[0].kind, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("INBOX", "to the trash"), false);
	assert.equal(has("Trash", "to the trash"), true);
	assert.deepEqual(actions(), []);
	assert.equal(ref("to the trash").state, "gone");
	assert.ok(server.commands.some((command) => /UID MOVE \d+ "Trash"/.test(command.line)));
	assert.equal(
		server.commands.some((command) => /EXPUNGE|\\Deleted/i.test(command.line)),
		false,
	);
	await updateMessageStatusForUser(env, session, message("to the trash").id, "received");
	await check();
	assert.equal(message("to the trash").status, "received", "Kite's own move is not read back as a disappearance");
});

test("an action only reaches the provider when its setting was on when it happened", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, actions } = await start(t);
	await arrive("before the setting");
	await updateMessageStatusForUser(env, session, message("before the setting").id, "trash");
	await setTwoWay({ kiteDelete: "trash" });
	await writebackExternalAccount(env, accountId);
	await check();
	assert.deepEqual(actions(), []);
	assert.equal(server.listMessages("Trash").length, 0);
});

test("archiving moves to the Archive folder, and spam to the Spam folder", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, has, ref } = await start(t);
	await setTwoWay({ kiteArchive: "archive", kiteSpam: "spam" });
	await arrive("archive me");
	await arrive("spam me");
	await updateMessageStatusForUser(env, session, message("archive me").id, "archived");
	await updateMessageStatusForUser(env, session, message("spam me").id, "spam");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Archive", "archive me"), true);
	assert.equal(has("Junk", "spam me"), true);
	assert.equal(server.listMessages("INBOX").length, 0);
	assert.equal(ref("archive me").state, "gone");
});

test("on Gmail archiving moves to All Mail, found by its special-use attribute", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, has } = await start(t, {
		gmail: true,
		folders: { INBOX: [], "[Gmail]/All Mail": [], "[Gmail]/Trash": [], "[Gmail]/Spam": [] },
		folderAttributes: {
			"[Gmail]/All Mail": ["\\All"],
			"[Gmail]/Trash": ["\\Trash"],
			"[Gmail]/Spam": ["\\Junk"],
		},
	});
	await setTwoWay({ kiteArchive: "archive", kiteDelete: "trash" });
	await arrive("gmail archive");
	await updateMessageStatusForUser(env, session, message("gmail archive").id, "archived");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("[Gmail]/All Mail", "gmail archive"), true);
	assert.equal(has("INBOX", "gmail archive"), false);
	assert.ok(server.commands.some((command) => command.line.includes('UID MOVE 1 "[Gmail]/All Mail"')));
});

test("a server without MOVE gets the UIDPLUS fallback: copy first, then exactly those UIDs; a bare EXPUNGE is never sent", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, has } = await start(t, { move: false });
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("copied first");
	const keep = server.addMessage("INBOX", { raw: sampleMessage(9, { subject: "marked by another client" }) });
	server.setFlags("INBOX", keep, ["\\Deleted"]);
	await updateMessageStatusForUser(env, session, message("copied first").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "copied first"), true);
	assert.equal(has("INBOX", "copied first"), false);
	assert.equal(has("INBOX", "marked by another client"), true, "what another client marked deleted stays");
	const lines = server.commands.map((command) => command.line.replace(/^\S+ /, ""));
	const order = ["UID COPY", "UID STORE", "UID EXPUNGE"].map((name) =>
		lines.findIndex((line) => line.startsWith(name)),
	);
	assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], lines.join(" | "));
	assert.equal(
		lines.some((line) => /^EXPUNGE/.test(line)),
		false,
	);
});

test("a server with neither MOVE nor UIDPLUS is not offered a move, and asking anyway is refused", async (t) => {
	const { env, accountId, setTwoWay } = await start(t, { move: false, uidplus: false });
	const view = await readTwoWayView(env, owner, accountId);
	assert.equal(view.support.moveMethod, null);
	await assert.rejects(setTwoWay({ kiteDelete: "trash" }), { status: 409, code: "NOT_SUPPORTED" });
	await setTwoWay({ kiteFlags: true, providerGone: "trash", providerFlags: true });
});

test("no special-use Archive folder means archiving is not offered", async (t) => {
	const { setTwoWay } = await start(t, {
		folderAttributes: { Trash: ["\\Trash"], Junk: ["\\Junk"] },
	});
	await assert.rejects(setTwoWay({ kiteArchive: "archive" }), { status: 409, code: "NOT_SUPPORTED" });
	await setTwoWay({ kiteDelete: "trash" });
});

test("read and star go to the provider, silently, and read does not come back as a change", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, flagsAt, actions } = await start(t);
	await setTwoWay({ kiteFlags: true, providerFlags: true });
	await arrive("flags out");
	await check();
	await markMessageAsReadForUser(env, session, message("flags out").id);
	await recordKiteChange(env, [message("flags out").id], { kind: "flags", starred: true });
	assert.equal(actions().length, 1, "two changes to one message are one row");
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(flagsAt("INBOX", "flags out").sort(), ["\\Flagged", "\\Seen"]);
	assert.ok(server.commands.some((command) => /UID STORE 1 \+FLAGS\.SILENT \(\\Seen\)/.test(command.line)));
	await recordKiteChange(env, [message("flags out").id], { kind: "flags", read: false });
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(flagsAt("INBOX", "flags out"), ["\\Flagged"]);
	const before = server.commands.length;
	await check();
	assert.deepEqual(actions(), []);
	assert.equal(
		server.commands.slice(before).some((command) => /STORE/.test(command.line)),
		false,
		"nothing bounces back",
	);
});

test("read and star at the provider reach Kite, without going back out", async (t) => {
	const { server, setTwoWay, arrive, check, message, actions } = await start(t);
	await setTwoWay({ providerFlags: true, kiteFlags: true });
	const uid = await arrive("flags in");
	await check();
	server.setFlags("INBOX", uid, ["\\Seen", "\\Flagged"]);
	await check();
	assert.equal(message("flags in").read, 1);
	assert.equal(message("flags in").starred, 1);
	assert.deepEqual(actions(), []);
	server.setFlags("INBOX", uid, []);
	await check();
	assert.equal(message("flags in").read, 0);
	assert.equal(message("flags in").starred, 0);
	assert.equal(
		server.commands.some((command) => /STORE/.test(command.line)),
		false,
	);
});

test("deleted or moved out at the provider goes to Kite's Trash, never a hard delete, once a baseline was taken", async (t) => {
	const { server, setTwoWay, arrive, check, message, ref, db } = await start(t);
	const earlier = await arrive("gone before turning on");
	server.removeMessage("INBOX", earlier);
	const later = await arrive("gone after turning on");
	await setTwoWay({ providerGone: "trash" });
	await check();
	assert.equal(message("gone before turning on").status, "received", "the baseline changes nothing in Kite");
	assert.equal(ref("gone before turning on").state, "gone");
	server.removeMessage("INBOX", later);
	await check();
	assert.equal(message("gone after turning on").status, "trash");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
	await check();
	assert.equal(message("gone after turning on").status, "trash");
	assert.equal(writes(server).length, 0, "provider-to-Kite only reads");
});

test("a message Kite's user already restored stays: the provider's move is applied once", async (t) => {
	const { server, env, setTwoWay, arrive, check, message } = await start(t);
	await setTwoWay({ providerGone: "trash" });
	const uid = await arrive("restored");
	await check();
	server.removeMessage("INBOX", uid);
	await check();
	await updateMessageStatusForUser(env, session, message("restored").id, "received");
	await check();
	assert.equal(message("restored").status, "received");
});

test("a mass disappearance waits for a second check and says so", async (t) => {
	const { server, setTwoWay, arrive, check, message, problems } = await start(t);
	await setTwoWay({ providerGone: "trash" });
	const subjects = Array.from({ length: 55 }, (_, index) => `bulk ${index}`);
	for (const [index, subject] of subjects.entries())
		server.addMessage("INBOX", {
			raw: sampleMessage(index + 100, { subject, messageId: `<${subject.replace(" ", "-")}@example.org>` }),
		});
	await check();
	await arrive("a last one");
	await check();
	const uids = server.listMessages("INBOX").map((entry) => entry.uid);
	for (const uid of uids) server.removeMessage("INBOX", uid);
	await check();
	assert.equal(message("bulk 0").status, "received");
	assert.ok(problems().some((text) => /left the Inbox at once/.test(text)));
	await check();
	assert.equal(message("bulk 0").status, "trash");
});

test("a new UIDVALIDITY moves and trashes nothing, and the mapping follows the messages to their new UIDs", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, ref, actions, has, problems } = await start(t);
	await setTwoWay({ kiteDelete: "trash", providerGone: "trash", providerFlags: true });
	const internalDate = new Date()
		.toUTCString()
		.replace(
			/^\w+, (\d+) (\w+) (\d+) (\S+) GMT$/,
			(_, day, month, year, time) => `${day}-${month}-${year} ${time} +0000`,
		);
	await arrive("kept 1");
	server.addMessage("INBOX", {
		raw: sampleMessage(2, { subject: "kept 2", messageId: "<kept-2@example.org>" }),
		internalDate,
	});
	await check();
	await updateMessageStatusForUser(env, session, message("kept 2").id, "trash");
	assert.equal(actions().length, 1);
	server.bumpUidValidity("INBOX");
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(actions(), [], "a row of the old UIDVALIDITY is dropped unread");
	assert.equal(has("INBOX", "kept 2"), true);
	assert.equal(server.listMessages("Trash").length, 0);
	assert.ok(problems().some((text) => /rebuilt a folder/.test(text)));
	await check();
	assert.equal(message("kept 1").status, "received", "old UIDs identify nothing, so nothing counts as gone");
	await check();
	assert.equal(ref("kept 2").uidvalidity, 2, "the reset's fetch re-points the mapping");
});

test("a UID that now holds another message is never touched", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, has, actions, problems, db } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("the real one");
	db.db.exec("UPDATE messages SET provider_message_id = '<someone-else@example.org>'");
	await updateMessageStatusForUser(env, session, message("the real one").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("INBOX", "the real one"), true);
	assert.equal(
		server.commands.some((command) => /MOVE/.test(command.line)),
		false,
	);
	assert.deepEqual(actions(), []);
	assert.ok(problems().some((text) => /no longer matched/.test(text)));
});

test("a refused move stays queued, shows in the account's problems, retries, and gives up after its tries", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, actions, problems, has, db } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("refused");
	await arrive("fine too");
	server.refuseWrite("MOVE", "NO [OVERQUOTA] Trash is full");
	await updateMessageStatusForUser(env, session, message("refused").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(actions()[0].attempts, 1);
	assert.ok(actions()[0].next_attempt_at > Date.now() / 1000);
	assert.ok(problems().some((text) => /could not move to the provider's Trash 1 message.*Trash is full/.test(text)));
	assert.equal((await readTwoWayView(env, owner, accountId)).pending, 1);
	await writebackExternalAccount(env, accountId);
	assert.equal(actions()[0].attempts, 1, "not due yet");
	server.refuseWrite("MOVE", null);
	db.db.exec("UPDATE external_provider_actions SET next_attempt_at = 0");
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(actions(), []);
	assert.equal(has("Trash", "refused"), true);

	server.refuseWrite("MOVE", "NO still full");
	await updateMessageStatusForUser(env, session, message("fine too").id, "trash");
	for (let attempt = 0; attempt < 6; attempt += 1) {
		db.db.exec("UPDATE external_provider_actions SET next_attempt_at = 0");
		await writebackExternalAccount(env, accountId);
	}
	assert.deepEqual(actions(), []);
	assert.ok(problems().some((text) => /gave up on 1 change/.test(text)));
	assert.equal(has("INBOX", "fine too"), true);
});

test("a message the server will not read waits and retries; the rest of its batch goes", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, actions, has, db } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("readable");
	await arrive("also readable");
	const bad = server.addMessage("INBOX", {
		raw: sampleMessage(3, { subject: "unreadable", messageId: "<unreadable@example.org>" }),
		unfetchable: true,
	});
	db.db.exec("UPDATE external_accounts SET next_sync_at = 0");
	await recordKiteChange(env, [message("readable").id, message("also readable").id], { kind: "trash" });
	db.db
		.prepare(
			"INSERT INTO external_provider_actions (id, account_id, message_id, kind, role, uidvalidity, uid, created_at, next_attempt_at) VALUES ('x:move', ?, 'x', 'trash', 'inbox', 1, ?, 1, 1)",
		)
		.run(accountId, bad);
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "readable"), true);
	assert.equal(has("Trash", "also readable"), true);
	assert.equal(has("INBOX", "unreadable"), true);
	assert.equal(actions().length, 1, "refused is not gone: it stays and retries");
	assert.equal(actions()[0].attempts, 1);
});

test("a flag change for a message deleted at the provider still lets the deletion reach Kite", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, actions } = await start(t);
	await setTwoWay({ kiteFlags: true, providerGone: "trash" });
	const uid = await arrive("read here, deleted there");
	await check();
	await recordKiteChange(env, [message("read here, deleted there").id], { kind: "flags", read: true });
	server.removeMessage("INBOX", uid);
	await writebackExternalAccount(env, accountId);
	assert.deepEqual(actions(), []);
	await check();
	assert.equal(message("read here, deleted there").status, "trash");
});

test("one refused message does not hold back the rest of its batch", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, message, actions, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("first");
	await arrive("second");
	const original = server.commands.push;
	let batches = 0;
	server.commands.push = function (entry) {
		// The batch is refused once; the same messages alone go through.
		if (/UID MOVE \d+,\d+/.test(entry.line) && batches++ === 0) server.refuseWrite("MOVE", "NO batch refused");
		else if (/UID MOVE \d+ /.test(entry.line)) server.refuseWrite("MOVE", null);
		return original.call(this, entry);
	};
	await recordKiteChange(env, [message("first").id, message("second").id], { kind: "trash" });
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "first"), true);
	assert.equal(has("Trash", "second"), true);
	assert.deepEqual(actions(), []);
});

test("an Undo before the run cancels the move; a run writes one delayed message per burst", async (t) => {
	const { server, env, accountId, agent, setTwoWay, arrive, message, actions } = await start(t);
	await setTwoWay({ kiteDelete: "trash", kiteArchive: "archive" });
	await arrive("undone");
	await arrive("burst");
	agent.length = 0;
	await updateMessageStatusForUser(env, session, message("undone").id, "trash");
	await updateMessageStatusForUser(env, session, message("burst").id, "archived");
	assert.equal(agent.length, 1, "one message for the burst");
	assert.deepEqual(agent[0].message, { kind: "accounts.writeback", accountId });
	assert.equal(agent[0].options.delaySeconds, 60);
	await updateMessageStatusForUser(env, session, message("undone").id, "received");
	await recordKiteChange(env, [message("burst").id], { kind: "other" });
	assert.deepEqual(actions(), []);
	await writebackExternalAccount(env, accountId);
	assert.equal(server.listMessages("INBOX").length, 2);
});

test("Delete forever moves to the provider's Trash, even though the message is gone from Kite; retention does not", async (t) => {
	const { server, env, accountId, db, setTwoWay, arrive, message, has } = await start(t);
	await arrive("forever");
	await arrive("retention");
	await updateMessageStatusForUser(env, session, message("forever").id, "trash");
	await updateMessageStatusForUser(env, session, message("retention").id, "trash");
	await setTwoWay({ kiteDelete: "trash" });
	const row = (subject) => {
		const found = message(subject);
		return { id: found.id, mailboxId: found.mailbox_id, rawR2Key: found.raw_r2_key, status: found.status };
	};
	await permanentlyDeleteMessages(env, getDb(env), "owner", [row("forever")], "bulk");
	await permanentlyDeleteMessages(env, getDb(env), "owner", [row("retention")], "retention");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "forever"), true);
	assert.equal(has("INBOX", "retention"), true);
	assert.equal(
		server.commands.some((command) => /EXPUNGE/.test(command.line)),
		false,
	);
});

test("last writer wins: an old stuck action loses to a newer provider change, a fresh one overwrites it", async (t) => {
	const { server, env, accountId, setTwoWay, arrive, check, message, db, actions, flagsAt } = await start(t);
	await setTwoWay({ kiteFlags: true, providerFlags: true });
	const stuck = await arrive("older action");
	const fresh = await arrive("newer action");
	const refused = await arrive("waiting action");
	await check();
	const hour = 3600;
	const now = Math.floor(Date.now() / 1000);
	// Each is marked unread in Kite, and read at the provider: the two sides really disagree.
	await recordKiteChange(env, [message("older action").id], { kind: "flags", read: false });
	await recordKiteChange(env, [message("newer action").id], { kind: "flags", read: false });
	await recordKiteChange(env, [message("waiting action").id], { kind: "flags", read: false });
	for (const uid of [stuck, fresh, refused]) server.setFlags("INBOX", uid, ["\\Seen"]);
	db.db.prepare("UPDATE external_two_way_state SET last_pass_at = ?").run(now - hour);
	db.db
		.prepare("UPDATE external_provider_actions SET created_at = ? WHERE message_id = ?")
		.run(now - 2 * hour, message("older action").id);
	db.db
		.prepare("UPDATE external_provider_actions SET created_at = ?, next_attempt_at = ? WHERE message_id = ?")
		.run(now - 2 * hour, now + hour, message("waiting action").id);

	await writebackExternalAccount(env, accountId);
	assert.deepEqual(flagsAt("INBOX", "older action"), ["\\Seen"], "the provider's change is newer and stands");
	assert.deepEqual(flagsAt("INBOX", "newer action"), [], "Kite's action is newer and overwrites it");

	await check();
	assert.equal(message("older action").read, 1, "Kite takes the newer value");
	assert.equal(message("newer action").read, 0);
	assert.equal(message("waiting action").read, 1, "a pass settles an action still waiting the same way");
	assert.deepEqual(actions(), [], "and the action it beat is gone");
});

test("a pause holds everything, and resuming applies what waited", async (t) => {
	const { server, env, accountId, db, setTwoWay, arrive, check, message, actions, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash", providerGone: "trash" });
	const uid = await arrive("paused");
	await check();
	await arrive("waits");
	await updateExternalAccount(env, owner, accountId, { syncEnabled: false });
	await updateMessageStatusForUser(env, session, message("waits").id, "trash");
	server.removeMessage("INBOX", uid);
	const before = server.commands.length;
	await writebackExternalAccount(env, accountId);
	await check();
	assert.equal(server.commands.length, before, "no session at all");
	assert.equal(actions().length, 1);
	assert.equal(message("paused").status, "received");
	await updateExternalAccount(env, owner, accountId, { syncEnabled: true });
	db.db.exec("UPDATE external_provider_actions SET next_attempt_at = 0");
	await check();
	assert.equal(has("Trash", "waits"), true);
	assert.equal(message("paused").status, "trash");
});

test("a run holding the lease keeps a second session out", async (t) => {
	const { server, env, accountId, db, setTwoWay, arrive, message, actions } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("leased");
	await updateMessageStatusForUser(env, session, message("leased").id, "trash");
	db.db.prepare("UPDATE external_accounts SET lease_until = ?").run(Math.floor(Date.now() / 1000) + 600);
	const before = server.commands.length;
	await writebackExternalAccount(env, accountId);
	assert.equal(server.commands.length, before);
	assert.equal(actions().length, 1);
});

test("turning a setting off drops what waits for it", async (t) => {
	const { env, accountId, setTwoWay, arrive, message, actions, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash", kiteFlags: true });
	await arrive("changed my mind");
	await updateMessageStatusForUser(env, session, message("changed my mind").id, "trash");
	await recordKiteChange(env, [message("changed my mind").id], { kind: "flags", read: true });
	assert.equal(actions().length, 2);
	await setTwoWay({ kiteFlags: true });
	assert.deepEqual(
		actions().map((row) => row.kind),
		["flags"],
	);
	await writebackExternalAccount(env, accountId);
	assert.equal(has("INBOX", "changed my mind"), true);
});

test("shared mailboxes: a member's action counts, and mail left behind in an old mailbox does not", async (t) => {
	const { env, accountId, setTwoWay, arrive, message, actions, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("shared");
	await arrive("left behind");
	await updateMessageStatusForUser(env, { id: "other", role: "user" }, message("shared").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "shared"), true);
	await updateExternalAccount(env, owner, accountId, { mailboxId: "mailbox-b" });
	await updateMessageStatusForUser(env, { id: "other", role: "user" }, message("left behind").id, "trash");
	assert.deepEqual(actions(), []);
});

test("a paused or suspended account's password is not used to ask the server", async (t) => {
	const { server, db, env, accountId } = await start(t);
	await updateExternalAccount(env, owner, accountId, { syncEnabled: false });
	const signIns = () => server.commands.filter((command) => /AUTHENTICATE/.test(command.line)).length;
	const before = signIns();
	assert.equal((await readTwoWayView(env, owner, accountId)).support, null);
	await updateExternalAccount(env, owner, accountId, { syncEnabled: true });
	db.db.prepare("UPDATE external_accounts SET suspended_at = ?").run(1);
	assert.equal((await readTwoWayView(env, owner, accountId)).support, null);
	assert.equal(signIns(), before);
});

test("only the account's owner reads or changes its settings", async (t) => {
	const { env, accountId } = await start(t);
	const stranger = { ...owner, id: "other" };
	await assert.rejects(readTwoWayView(env, stranger, accountId), { status: 404 });
	await assert.rejects(saveTwoWay(env, stranger, accountId, OFF), { status: 404 });
});

test("messages fetched before the feature are linked from their raw keys and adopted without changing anything", async (t) => {
	const { server, env, accountId, db, setTwoWay, arrive, check, message, ref, has } = await start(t);
	const uid = await arrive("older one");
	await arrive("acted on");
	db.db.exec("DELETE FROM external_message_refs");
	await setTwoWay({ kiteDelete: "trash", providerGone: "trash", providerFlags: true });
	server.setFlags("INBOX", uid, ["\\Seen"]);
	await check();
	assert.equal(ref("older one").provider_read, 1);
	assert.equal(message("older one").read, 0, "first sight is a baseline");
	await updateMessageStatusForUser(env, session, message("acted on").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "acted on"), true);
});

test("an action on a message with no mapping row yet uses its raw key", async (t) => {
	const { env, accountId, db, setTwoWay, arrive, message, has } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("no row");
	db.db.exec("DELETE FROM external_message_refs");
	await updateMessageStatusForUser(env, session, message("no row").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.equal(has("Trash", "no row"), true);
});

test("CONDSTORE skips a pass when nothing moved, and a change is still seen", async (t) => {
	const { server, setTwoWay, arrive, check, message } = await start(t, { condstore: true });
	await setTwoWay({ providerFlags: true });
	const uid = await arrive("quiet");
	await check();
	await check();
	const before = server.commands.length;
	await check();
	assert.equal(
		server.commands.slice(before).some((command) => /UID FETCH/.test(command.line)),
		false,
		"one EXAMINE was the whole check",
	);
	server.setFlags("INBOX", uid, ["\\Flagged"]);
	await check();
	assert.equal(message("quiet").starred, 1);
});

test("mail in the provider's Spam folder is not reconciled", async (t) => {
	const { server, env, accountId, setTwoWay, check, message, has } = await start(t);
	await updateExternalAccount(env, owner, accountId, { syncJunk: true });
	await check();
	await setTwoWay({ providerGone: "trash", kiteDelete: "trash" });
	const uid = server.addMessage("Junk", {
		raw: sampleMessage(1, { subject: "junk one", messageId: "<junk@example.org>" }),
	});
	await check();
	assert.equal(message("junk one").status, "spam");
	server.removeMessage("Junk", uid);
	await check();
	assert.equal(message("junk one").status, "spam", "a provider purging its Spam folder changes nothing");
	const second = server.addMessage("Junk", {
		raw: sampleMessage(2, { subject: "junk two", messageId: "<junk-2@example.org>" }),
	});
	await check();
	await updateMessageStatusForUser(env, session, message("junk two").id, "trash");
	await writebackExternalAccount(env, accountId);
	assert.ok(second);
	assert.equal(has("Trash", "junk two"), true, "acting on it works from the folder it is in");
});

test("reconnecting to another login clears the mapping: its UIDs mean something else there", async (t) => {
	const { env, accountId, db, setTwoWay, arrive, message, check, actions } = await start(t);
	await setTwoWay({ kiteDelete: "trash", providerGone: "trash" });
	await arrive("old login");
	await updateMessageStatusForUser(env, session, message("old login").id, "trash");
	await updateExternalAccount(env, owner, accountId, {
		username: "second@example.test",
		password: PASSWORD,
		kitePassword: KITE_PASSWORD,
	});
	assert.deepEqual(actions(), []);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_message_refs").get().n, 0);
	await check();
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM external_message_refs").get().n,
		0,
		"old raw keys stay unlinked",
	);
});

test("a backup carries the settings but no mapping and no outbox", async (t) => {
	const { env, setTwoWay, arrive, message } = await start(t);
	await setTwoWay({ kiteDelete: "trash" });
	await arrive("in the backup");
	await updateMessageStatusForUser(env, session, message("in the backup").id, "trash");
	const backup = new TextDecoder().decode(await exportDatabaseRecords(env.DB));
	assert.ok(backup.includes("external_accounts"));
	for (const name of ["external_provider_actions", "external_message_refs", "external_two_way_state"])
		assert.equal(backup.includes(name), false, name);
	assert.match(backup, /kiteDelete/);
});

test("before the migration every path is a no-op and new mail still arrives", async (t) => {
	const { server, db, env, accountId, inboundOf, arrive, message } = await start(t);
	await arrive("behind");
	db.db.exec(
		"DROP TABLE external_provider_actions; DROP TABLE external_message_refs; DROP TABLE external_two_way_state;",
	);
	// A new object: the readiness of the database above is remembered for this process.
	const behindDb = new Proxy(env.DB, {
		get: (target, key) => (typeof target[key] === "function" ? target[key].bind(target) : target[key]),
	});
	const behind = { ...env, DB: behindDb };
	await recordKiteChange(behind, [message("behind").id], { kind: "trash" });
	await writebackExternalAccount(behind, accountId);
	server.addMessage("INBOX", sampleMessage(7, { subject: "after the deploy" }));
	db.db.exec("UPDATE external_accounts SET next_sync_at = 0, lease_until = NULL, last_sync_at = NULL");
	const result = await syncExternalAccount(behind, accountId);
	assert.equal(result.delivered, 1);
	for (const queued of inboundOf.splice(0)) await processInboundMessage(behind, queued);
	assert.ok(message("after the deploy"));
	assert.deepEqual(writes(server), []);
});
