import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Identity, threading, forwarding and notifications for received mail (upstream Mailflare #220, #223, #224, #226),
// against the self-hosted database and file bucket.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-inbound-identity-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/** Automatic reading is not under test here; the real scheduler would pull in the whole agent. */
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

await build({
	entryPoints: {
		deliver: join(root, "src/lib/email/inbound-deliver.ts"),
		contacts: join(root, "src/lib/contacts/service.ts"),
		contactUtils: join(root, "src/lib/contacts/utils.ts"),
		threading: join(root, "src/lib/email/threading.ts"),
		joinUtils: join(root, "src/lib/email/thread-join-utils.ts"),
		threadView: join(root, "src/lib/email/thread-view.ts"),
		intake: join(root, "src/lib/email/intake.ts"),
		forwarding: join(root, "src/lib/email/account-forwarding.ts"),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		bucket: join(root, "server/runtime/file-bucket.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	plugins: [stubAgentSchedule],
	alias: {
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { deliverInboundMessage } = await load("deliver");
const { upsertContactFromAddress, getMessageContactNames } = await load("contacts");
const { getSenderDisplayName } = await load("contactUtils");
const { resolveThreadId } = await load("threading");
const { dmarcAlignedPass, isThreadParticipant } = await load("joinUtils");
const { getMessageThreadForUser } = await load("threadView");
const { intakeIncomingMail } = await load("intake");
const { forwardedMarker, wasForwardedByKite } = await load("forwarding");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { FileBucket } = await load("bucket");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
/** Every outside request a test made: Gravatar lookups and webhook posts. Nothing leaves the test. */
const requests = [];
globalThis.fetch = async (url) => {
	requests.push(String(url));
	return new Response("", { status: 404 });
};
const gravatarLookups = () => requests.filter((url) => url.startsWith("https://gravatar.com/")).length;
// Delivery logs what it drops; keep the test output readable.
for (const level of ["info", "warn", "error"]) console[level] = () => {};

const encoder = new TextEncoder();
const OWNER = { id: "owner", email: "owner@example.com", role: "admin", isPrimaryAdmin: true, disabled: false };
const CLOUDFLARE_DMARC_PASS = (domain) =>
	`mx.cloudflare.net; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=pass header.from=${domain}`;

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	const directory = mkdtempSync(join(tmpdir(), "kite-inbound-identity-bucket-"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1), ('mailbox-s', 'owner', 'domain-1', 's', 1);
		INSERT INTO screener_settings (mailbox_id, enabled, mode, created_at, updated_at) VALUES ('mailbox-s', 1, 'screener', 1, 1);
	`);
	const notices = [];
	const env = {
		DB: database,
		BUCKET: new FileBucket(directory),
		REALTIME: {
			getByName: () => ({
				fetch: async (_url, init) => {
					notices.push(JSON.parse(init.body));
					return new Response("ok");
				},
			}),
		},
		OUTBOUND_QUEUE: { send: async () => {} },
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	requests.length = 0;
	const row = (sql, ...params) => database.db.prepare(sql).get(...params);
	return { database, env, notices, row, db: getDb(env) };
}

/** A raw message; header values left out are not written. */
function mail({ from, to = "a@example.com", cc, id, inReplyTo, references, subject = "Hi" }) {
	return [
		`From: ${from}`,
		`To: ${to}`,
		cc && `Cc: ${cc}`,
		`Subject: ${subject}`,
		id && `Message-ID: <${id}>`,
		inReplyTo && `In-Reply-To: <${inReplyTo}>`,
		references && `References: ${references.map((ref) => `<${ref}>`).join(" ")}`,
		"",
		"Hello there",
		"",
	]
		.filter((line) => typeof line === "string")
		.join("\r\n");
}

let counter = 0;
/** Delivers like the queue consumer does, with the intake hop's trusted `Authentication-Results` when given. */
async function deliver(f, message, { auth = null, mailboxId = "mailbox-a" } = {}) {
	const raw = encoder.encode(mail(message));
	const rawR2Key = `inbound/${Date.now()}-${(counter += 1)}.eml`;
	await f.env.BUCKET.put(rawR2Key, raw);
	const outcome = await deliverInboundMessage(f.env, {
		target: { mailboxId, userId: "owner" },
		from: "bounce@partner.test",
		to: message.to ?? "a@example.com",
		rawR2Key,
		raw: raw.buffer,
		deliveredAddress: message.to ?? "a@example.com",
		headers: {},
		authenticationResults: auth,
	});
	assert.equal(outcome.delivered, true, JSON.stringify(outcome));
	return f.row("SELECT * FROM messages WHERE id = ?", outcome.messageId);
}

/** A conversation Alice started with the mailbox, copying Carol. */
async function conversation(f) {
	return deliver(f, {
		from: "Alice <alice@partner.test>",
		cc: "Carol <carol@partner.test>",
		id: "root@partner.test",
		subject: "Plans",
	});
}

test("a reply joins the conversation only when its sender takes part in it or passed DMARC", async (t) => {
	const f = await setup(t);
	const root = await conversation(f);
	assert.equal(root.thread_id, "root@partner.test");
	const reply = (from, id, auth) =>
		deliver(f, { from, id, inReplyTo: "root@partner.test", references: ["root@partner.test"] }, { auth });

	assert.equal((await reply("Alice <alice@partner.test>", "r1@partner.test")).thread_id, root.thread_id);
	// Someone copied on the conversation is a participant too.
	assert.equal((await reply("carol@partner.test", "r2@partner.test")).thread_id, root.thread_id);
	// A stranger naming the conversation's Message-ID starts a thread of its own.
	const forged = await reply('"Alice" <alice@evil.test>', "r3@evil.test");
	assert.notEqual(forged.thread_id, root.thread_id);
	assert.match(forged.thread_id, /^thr_/);
	// Someone newly copied by Alice is not a participant yet: without DMARC the reply stands alone (the trade-off) ...
	assert.notEqual((await reply("Dave <dave@partner.test>", "r4@partner.test")).thread_id, root.thread_id);
	// ... and with a DMARC pass for its own From domain it joins.
	const dave = await reply("Dave <dave@partner.test>", "r5@partner.test", CLOUDFLARE_DMARC_PASS("partner.test"));
	assert.equal(dave.thread_id, root.thread_id);
	// A mailing list relaying a reply is not a participant, but signs as itself.
	const list = await reply(
		"Planning list <plans@lists.example>",
		"r6@lists.example",
		CLOUDFLARE_DMARC_PASS("lists.example"),
	);
	assert.equal(list.thread_id, root.thread_id);
	// A DMARC pass for some other domain does not count.
	const other = await reply("Mallory <m@evil.test>", "r7@evil.test", CLOUDFLARE_DMARC_PASS("partner.test"));
	assert.notEqual(other.thread_id, root.thread_id);
	// A participant matched as a whole address, never as a substring of one.
	assert.notEqual((await reply("ice@partner.test", "r8@partner.test")).thread_id, root.thread_id);
});

test("received mail never seeds into a thread its Message-ID already keys", async (t) => {
	const f = await setup(t);
	const root = await conversation(f);
	// A new message whose own Message-ID is the conversation's key, without naming any parent.
	const stranger = await deliver(f, { from: "Mallory <m@evil.test>", id: "root@partner.test" });
	assert.notEqual(stranger.thread_id, root.thread_id);
	// Not even from a participant who passed DMARC: a reused Message-ID is not a reply.
	const alice = await deliver(
		f,
		{ from: "Alice <alice@partner.test>", id: "root@partner.test" },
		{ auth: CLOUDFLARE_DMARC_PASS("partner.test") },
	);
	assert.notEqual(alice.thread_id, root.thread_id);
	// A fresh Message-ID still seeds its own thread, so replies find it.
	assert.equal((await deliver(f, { from: "m@evil.test", id: "fresh@evil.test" })).thread_id, "fresh@evil.test");
});

test("imports, synced mail and JMAP drafts keep joining on the headers alone", async (t) => {
	const f = await setup(t);
	const root = await conversation(f);
	// They pass no sender: they are the user's own history.
	const imported = await resolveThreadId(f.db, {
		mailboxId: "mailbox-a",
		messageId: "<old@elsewhere.test>",
		inReplyTo: "root@partner.test",
		references: ["root@partner.test"],
	});
	assert.equal(imported, root.thread_id);
	const synced = await resolveThreadId(f.db, {
		mailboxId: "mailbox-a",
		messageId: "<root@partner.test>",
		fallback: "references-root",
	});
	assert.equal(synced, "root@partner.test");
});

test("the join rule's helpers: DMARC aligned with the From domain, whole-address participants", () => {
	assert.equal(dmarcAlignedPass(CLOUDFLARE_DMARC_PASS("partner.test"), "Alice <alice@partner.test>"), true);
	assert.equal(dmarcAlignedPass(CLOUDFLARE_DMARC_PASS("partner.test"), "alice@PARTNER.test"), true);
	assert.equal(dmarcAlignedPass(CLOUDFLARE_DMARC_PASS("partner.test"), "alice@sub.partner.test"), false);
	assert.equal(dmarcAlignedPass("mx.cloudflare.net; dmarc=fail header.from=partner.test", "a@partner.test"), false);
	assert.equal(dmarcAlignedPass("mx.cloudflare.net; dkim=pass header.d=partner.test", "a@partner.test"), false);
	assert.equal(dmarcAlignedPass(null, "a@partner.test"), false);
	// SES names no header.from; its verdict is for the From header it saw.
	assert.equal(dmarcAlignedPass("amazonses.com; spf=pass; dkim=pass; dmarc=pass", "a@partner.test"), true);

	const rows = [
		{
			fromAddr: "Alice <alice@partner.test>",
			toAddr: "a@example.com",
			ccAddr: '"Chen, Maya" <maya@x.test>',
			bccAddr: null,
		},
		{ fromAddr: "a@example.com", toAddr: "alice@partner.test", ccAddr: null, bccAddr: "boss@x.test" },
	];
	assert.equal(isThreadParticipant("MAYA@x.test", rows), true);
	assert.equal(isThreadParticipant("Boss <boss@x.test>", rows), true);
	assert.equal(isThreadParticipant("aya@x.test", rows), false);
	assert.equal(isThreadParticipant("", rows), false);
});

test("inbound mail names a contact but never renames one; outbound and manual names behave as before", async (t) => {
	const f = await setup(t);
	const name = (email) => f.row("SELECT display_name, source FROM contacts WHERE email = ?", email);
	await deliver(f, { from: "Alice Anders <alice@partner.test>", id: "1@partner.test" });
	await deliver(f, { from: "The CEO <alice@partner.test>", id: "2@partner.test" });
	assert.deepEqual({ ...name("alice@partner.test") }, { display_name: "Alice Anders", source: "inbound" });

	// A contact learned without a name gets the first one mail brings.
	await deliver(f, { from: "bob@partner.test", id: "3@partner.test" });
	assert.equal(name("bob@partner.test").display_name, null);
	await deliver(f, { from: "Bob Brown <bob@partner.test>", id: "4@partner.test" });
	assert.equal(name("bob@partner.test").display_name, "Bob Brown");

	// The user addressing someone by a name still renames the contact.
	await upsertContactFromAddress(f.env, {
		userId: "owner",
		address: "Alice A. <alice@partner.test>",
		source: "outbound",
	});
	assert.equal(name("alice@partner.test").display_name, "Alice A.");
	// And a name the user saved is kept against anything.
	f.database.db.exec(
		"UPDATE contacts SET display_name = 'My Alice', source = 'manual' WHERE email = 'alice@partner.test'",
	);
	await deliver(f, { from: "Someone Else <alice@partner.test>", id: "5@partner.test" });
	await upsertContactFromAddress(f.env, { userId: "owner", address: "Other <alice@partner.test>", source: "outbound" });
	assert.deepEqual({ ...name("alice@partner.test") }, { display_name: "My Alice", source: "manual" });
});

test("each message keeps its own sender name: manual contact name, then From name, then learned name", async (t) => {
	const shared = { displayName: "LiveKit Hiring Team", source: "inbound" };
	assert.equal(getSenderDisplayName('"PostHog Team" <no-reply@ashbyhq.com>', shared), "PostHog Team");
	assert.equal(
		getSenderDisplayName('"LiveKit Hiring Team" <no-reply@ashbyhq.com>', {
			displayName: "PostHog Team",
			source: "outbound",
		}),
		"LiveKit Hiring Team",
	);
	assert.equal(
		getSenderDisplayName('"PostHog Team" <no-reply@ashbyhq.com>', {
			displayName: "Ashby Recruiting",
			source: "manual",
		}),
		"Ashby Recruiting",
	);
	assert.equal(getSenderDisplayName("no-reply@ashbyhq.com", shared), "LiveKit Hiring Team");
	assert.equal(getSenderDisplayName("no-reply@ashbyhq.com", null), null);
	// A From name that is only the address is no name.
	assert.equal(getSenderDisplayName('"no-reply@ashbyhq.com" <no-reply@ashbyhq.com>', shared), "LiveKit Hiring Team");

	const f = await setup(t);
	const posthog = await deliver(f, { from: '"PostHog Team" <no-reply@ashbyhq.com>', id: "p@ashbyhq.com" });
	const livekit = await deliver(f, {
		from: '"LiveKit Hiring Team" <no-reply@ashbyhq.com>',
		id: "l@ashbyhq.com",
		inReplyTo: "p@ashbyhq.com",
	});
	assert.equal(livekit.thread_id, posthog.thread_id, "the same sender continues its own thread");
	const shown = async () =>
		(await getMessageThreadForUser(f.env, OWNER, livekit.id)).messages.map((message) => message.fromContactName);
	assert.deepEqual(await shown(), ["PostHog Team", "LiveKit Hiring Team"]);
	assert.equal(
		(await getMessageContactNames(f.env, "owner", posthog.from_addr, posthog.to_addr)).fromContactName,
		"PostHog Team",
	);
	f.database.db.exec(
		"UPDATE contacts SET display_name = 'Ashby', source = 'manual' WHERE email = 'no-reply@ashbyhq.com'",
	);
	assert.deepEqual(await shown(), ["Ashby", "Ashby"]);
});

test("spam stays out of a conversation unless it is the message being opened", async (t) => {
	const f = await setup(t);
	f.database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, thread_id, created_at) VALUES
			('m1', 'owner', 'mailbox-a', 'inbound', 'alice@partner.test', 'a@example.com', 'received', 't', 1),
			('m2', 'owner', 'mailbox-a', 'inbound', 'm@evil.test', 'a@example.com', 'spam', 't', 2),
			('m3', 'owner', 'mailbox-a', 'outbound', 'a@example.com', 'alice@partner.test', 'sent', 't', 3);
	`);
	const ids = async (id) => (await getMessageThreadForUser(f.env, OWNER, id)).messages.map((message) => message.id);
	assert.deepEqual(await ids("m1"), ["m1", "m3"]);
	assert.deepEqual(await ids("m2"), ["m1", "m2", "m3"]);
});

test("spam, trash and held mail: no Gravatar lookup; spam and trash: no notice and no webhook", async (t) => {
	const f = await setup(t);
	f.database.db.exec(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_field, match_operator, match_value, mailbox_id, action, priority, created_at) VALUES
			('to-trash', 'owner', 'domain-1', 'mailbox', 'blocked@partner.test', 'email', 'exact', 'blocked@partner.test', 'mailbox-a', 'trash', 100, 1),
			('to-spam', 'owner', 'domain-1', 'mailbox', 'junk@partner.test', 'email', 'exact', 'junk@partner.test', 'mailbox-a', 'spam', 100, 1);
		INSERT INTO webhooks (id, user_id, url, secret, events, created_at) VALUES ('hook', 'owner', 'https://hooks.partner.test/in', 'secret', '["message.inbound"]', 1);
	`);
	const webhooks = () => f.row("SELECT count(*) AS count FROM webhook_deliveries").count;

	const trashed = await deliver(f, { from: "Blocked <blocked@partner.test>", id: "t@partner.test" });
	const spam = await deliver(f, { from: "junk@partner.test", id: "s@partner.test" });
	assert.deepEqual([trashed.status, spam.status], ["trash", "spam"]);
	const held = await deliver(
		f,
		{ from: "stranger@partner.test", to: "s@example.com", id: "h@partner.test" },
		{ mailboxId: "mailbox-s" },
	);
	assert.equal(held.status, "screening");
	assert.equal(gravatarLookups(), 0, "nobody filed away or undecided was looked up");
	assert.equal(f.notices.length, 0);
	// Held mail still reaches webhooks, as docs/screener.md says.
	assert.equal(webhooks(), 1);
	assert.ok(f.row("SELECT 1 FROM contacts WHERE email = 'blocked@partner.test'"), "the contact is still recorded");

	await deliver(f, { from: "The CEO <alice@partner.test>", id: "ok@partner.test" });
	assert.equal(gravatarLookups(), 1);
	assert.equal(webhooks(), 2);
	assert.equal(f.notices.length, 1);
	assert.equal(f.notices[0].fromName, "The CEO");
	assert.equal(f.notices[0].from, '"The CEO" <alice@partner.test>');
});

test("the forward marker is signed with a server secret, and only this install's own value stops forwarding", async (t) => {
	const f = await setup(t);
	f.database.db.exec("UPDATE users SET forwarding_email = 'me@elsewhere.test' WHERE id = 'owner'");
	const queued = [];
	const env = { ...f.env, APP_ENCRYPTION_KEY: "app-key", INBOUND_QUEUE: { send: async (body) => queued.push(body) } };
	const marker = await forwardedMarker(env);
	assert.match(marker, /^v1\.[0-9a-f]{64}$/);
	const intake = async (headers) => {
		const forwards = [];
		await intakeIncomingMail(
			env,
			{
				from: "x@partner.test",
				to: "a@example.com",
				raw: encoder.encode(mail({ from: "x@partner.test" })).buffer,
				headers,
			},
			{ forward: async (destination, extra) => forwards.push({ destination, extra }) },
		);
		return forwards;
	};

	assert.deepEqual(await intake({}), [{ destination: "me@elsewhere.test", extra: { "X-Kite-Forwarded": marker } }]);
	// A sender cannot switch forwarding off with the old unsigned value, under either name.
	assert.equal((await intake({ "x-kite-forwarded": "1" })).length, 1);
	assert.equal((await intake({ "X-Mailflare-Forwarded": "1" })).length, 1);
	// This install's own marker stops it, also when another install added its value first.
	assert.equal((await intake({ "x-kite-forwarded": marker })).length, 0);
	assert.equal((await intake({ "x-kite-forwarded": `v1.${"0".repeat(64)}, ${marker}` })).length, 0);
	assert.equal((await intake({ "x-mailflare-forwarded": marker })).length, 0);
	// Another install's marker is forwarded once more; that install then stops it on the way back.
	const other = { APP_ENCRYPTION_KEY: "other-key" };
	const theirs = await forwardedMarker(other);
	assert.equal((await intake({ "x-kite-forwarded": theirs })).length, 1);
	assert.equal(await wasForwardedByKite(other, (name) => ({ "x-kite-forwarded": `${marker}, ${theirs}` })[name]), true);
	assert.ok(queued.length > 0, "every message was still stored");
});

test("the marker key: APP_ENCRYPTION_KEY, else INBOUND_WEBHOOK_SECRET, else CF_TOKEN, else the unsigned 1", async () => {
	const all = await forwardedMarker({ APP_ENCRYPTION_KEY: "a", INBOUND_WEBHOOK_SECRET: "b", CF_TOKEN: "c" });
	assert.equal(all, await forwardedMarker({ APP_ENCRYPTION_KEY: "a" }));
	const webhook = await forwardedMarker({ APP_ENCRYPTION_KEY: " ", INBOUND_WEBHOOK_SECRET: "b", CF_TOKEN: "c" });
	assert.equal(webhook, await forwardedMarker({ INBOUND_WEBHOOK_SECRET: "b" }));
	assert.notEqual(webhook, all);
	assert.equal(await forwardedMarker({ CF_TOKEN: "c" }), await forwardedMarker({ CF_TOKEN: "c", CF_API_KEY: "x" }));
	assert.notEqual(await forwardedMarker({ CF_TOKEN: "c" }), webhook);
	assert.equal(await forwardedMarker({}), "1");
	assert.equal(await wasForwardedByKite({}, (name) => ({ "X-Kite-Forwarded": "1" })[name]), true);
	assert.equal(await wasForwardedByKite({ CF_TOKEN: "c" }, (name) => ({ "X-Kite-Forwarded": "1" })[name]), false);
});
