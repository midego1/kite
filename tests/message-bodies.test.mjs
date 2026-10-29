import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir } from "./support/module-database.mjs";
import { root } from "./support/modules-bundle.mjs";

const directory = makeBundleDirectory("kite-message-bodies-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { loadMessageBodies, canOffloadHtmlBodies, MessageBodyUnavailableError } from "./src/lib/email/bodies.ts";
			export { derivedTextBody } from "./src/lib/email/bodies-utils.ts";
			export { importMessagesToMailbox } from "./src/lib/import/service.ts";
			export { deleteMessageWithObjects } from "./src/lib/email/message-cleanup.ts";
			export { permanentlyDeleteMessages } from "./src/lib/email/permanent-delete.ts";
			export { deleteMailboxWithContents } from "./src/lib/mailboxes/delete.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { getMessageWithBodyForUser } from "./src/lib/email/inbound.ts";
			export { getMessageThreadForUser } from "./src/lib/email/thread-view.ts";
			export { emailGet, emailQuery } from "./src/lib/jmap/emails.ts";
			export { readBlob } from "./src/lib/jmap/blobs.ts";
			export { messageBlobId } from "./src/lib/jmap/ids.ts";
			export { GET as getV1Messages } from "./src/app/api/v1/messages/route.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
			export { loadTriageContext } from "./src/lib/agent/auto-read/triage-context.ts";
			export { loadDraftThread } from "./src/lib/agent/jobs/draft-generation.ts";
			export { getModuleMessage } from "./src/lib/email/module-read.ts";
			export { recentModuleMessagesFromSender } from "./src/lib/email/module-recent.ts";
			export { canProxyMessageImage } from "./src/lib/remote-images/message-access.ts";
			export { applySpamFeedback } from "./src/lib/spam/feedback.ts";
			export { exportMailboxToMbox } from "./src/lib/export/mbox.ts";
			export { createSummary } from "./src/lib/agent/summaries/service.ts";
			export { createComposeStream } from "./src/lib/agent/compose.ts";
		`,
		resolveDir: root,
		sourcefile: "message-bodies-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const BODY_KEY = "bodies/imp-1.html";
const IMAGE = "https://images.partner.test/logo.png";
// Over 16 KB, with a link, an image, an entity and a quoted part, so every reader has something to read.
const HTML = [
	`<div><p>Hello Alex, from the Café,</p><p>The quarterly report is attached &amp; the agenda is at <a href="https://partner.test/agenda">partner.test/agenda</a>.</p>`,
	`<img src="${IMAGE}" alt="Partner">`,
	`<p>${"Revenue grew in every region; the figures follow in the table. ".repeat(300)}</p>`,
	`<p>Kind regards, Sam</p></div><blockquote><p>On Monday Alex wrote: could you send the report?</p></blockquote>`,
].join("");
const TEXT = "Hello Alex,\n\nThe quarterly report is attached & the agenda is at https://partner.test/agenda.\n\nSam";

/** An R2 stand-in that counts reads, so a test can tell whether a reader touched the store. */
function memoryBucket() {
	const objects = new Map();
	const stats = { gets: 0 };
	return {
		objects,
		stats,
		async get(key) {
			stats.gets += 1;
			if (!objects.has(key)) return null;
			const value = objects.get(key);
			const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
			return {
				size: bytes.byteLength,
				body: new Response(bytes).body,
				text: async () => new TextDecoder().decode(bytes),
				arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			};
		},
		async head(key) {
			return objects.has(key) ? { size: 1 } : null;
		},
		async put(key, value) {
			objects.set(key, typeof value === "string" ? value : new Uint8Array(value));
		},
		async delete(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
	};
}

const user = {
	id: "owner",
	name: "Alex Owner",
	email: "owner@example.com",
	role: "admin",
	isPrimaryAdmin: true,
	disabled: false,
	agentMaxSteps: 5,
};
const API_KEY = "ep_bodiestestkey";

/**
 * A migrated database with one mailbox, the message `imp-1` (an inbound mail with `HTML`, and `TEXT` unless
 * `text` is null) and a short reply in the same conversation. With `offloaded` the HTML is where the import puts
 * a large body: in the bucket at `bodies/imp-1.html`, with `html_body` null and the text body kept.
 */
async function fixture(t, { offloaded, text = TEXT, migrations = migrationsDir } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, migrations);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Alex Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
		UPDATE app_settings SET agent_enabled = 1, agent_external_auto_read_allowed = 1, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'priced', agent_model_rates = '{"priced":{"input":1,"output":2}}';
	`);
	database.db
		.prepare(
			"INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('key-1', 'owner', 'Test', ?, ?, '[\"read\"]', 1)",
		)
		.run(API_KEY.slice(0, 12), bcrypt.hashSync(API_KEY, 4));
	const bucket = memoryBucket();
	const derived = offloaded && text === null;
	database.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, snippet, text_body, html_body, status, thread_id, created_at)
			VALUES ('imp-1', 'owner', 'mailbox-a', 'inbound', '<imp-1@partner.test>', 'Sam <sam@partner.test>', 'alex@example.com', 'Quarterly report', 'Hello Alex, the quarterly report', ?, ?, 'received', 'thread-1', 1790000000)`,
		)
		.run(derived ? m.derivedTextBody(HTML) : text, offloaded ? null : HTML);
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, snippet, text_body, status, thread_id, created_at)
		VALUES ('reply-1', 'owner', 'mailbox-a', 'outbound', 'reply-1@example.com', 'alex@example.com', 'sam@partner.test', 'Re: Quarterly report', 'Thanks', 'Thanks, Sam.', 'sent', 'thread-1', 1790000100);
	`);
	// Written as the import does, after the insert; both variants update the row, since JMAP's state counts changes.
	if (migrations === migrationsDir)
		database.db
			.prepare("UPDATE messages SET html_body_key = ?, body_size = ? WHERE id = 'imp-1'")
			.run(offloaded ? BODY_KEY : null, offloaded ? Buffer.byteLength(text ?? "") + Buffer.byteLength(HTML) : null);
	if (offloaded) bucket.objects.set(BODY_KEY, HTML);
	const env = { DB: database, BUCKET: bucket, AI: {} };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { database, env, bucket };
}

function jmapContext(env) {
	return {
		env,
		db: m.getDb(env),
		auth: { userId: "owner", email: "owner@example.com", scopes: ["jmap"], mailboxIds: null, user },
		accountId: "owner",
		origin: "https://kite.test",
		createdIds: {},
	};
}

const toolContext = (env) => ({ env, user, mailboxId: "mailbox-a", origin: "chat" });
const moduleContext = { viewer: { userId: "owner", role: "admin" }, mailboxIds: ["mailbox-a"] };
const loadRow = (env, id = "imp-1") =>
	m.getDb(env).query.messages.findFirst({ where: (messages, { eq }) => eq(messages.id, id) });

// The model requests a reader makes, recorded by a stand-in for the provider.
let modelRequests = [];
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	modelRequests = [];
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		modelRequests.push(body.messages);
		const content = JSON.stringify({
			language: "en",
			overview: "Sam sent the quarterly report.",
			points: [{ label: "Next steps", text: "Read the report." }],
		});
		if (!body.stream)
			return Response.json({
				id: "c",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
			});
		const chunk = (delta, finish = null) =>
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		return new Response(
			[chunk({ role: "assistant", content: "Thanks, I will read it." }), chunk({}, "stop"), "data: [DONE]\n\n"].join(
				"",
			),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	};
});

/** A reader's answer as plain JSON, with the random nonces of untrusted blocks in model prompts made equal. */
const json = (value) =>
	JSON.parse(
		JSON.stringify(value ?? null).replace(/nonce=[0-9a-f]+|<<<END [0-9a-f]+/g, (match) =>
			match.replace(/[0-9a-f]+$/, "N"),
		),
	);

/**
 * Every reader of message bodies, each answering what a caller would see. `html` says whether the answer must
 * show the HTML itself (not just text from it), which proves the offloaded body was read back.
 */
const READERS = [
	{
		name: "reader API (GET /api/messages/[id])",
		html: true,
		run: ({ env }) => m.getMessageWithBodyForUser(env, user, "imp-1"),
	},
	{
		name: "conversation thread (GET /api/messages/[id]/thread)",
		html: true,
		run: ({ env }) => m.getMessageThreadForUser(env, user, "imp-1"),
	},
	{
		name: "JMAP Email/get with body values",
		html: true,
		run: ({ env }) => m.emailGet(jmapContext(env), { accountId: "owner", ids: ["imp-1"], fetchAllBodyValues: true }),
	},
	{
		name: "JMAP Email/get size and structure",
		html: false,
		run: ({ env }) =>
			m.emailGet(jmapContext(env), {
				accountId: "owner",
				ids: ["imp-1"],
				properties: ["size", "bodyStructure", "htmlBody"],
			}),
	},
	{
		name: "JMAP blob of a message without raw MIME",
		html: true,
		run: async ({ env }) => {
			const blob = await m.readBlob(jmapContext(env), m.messageBlobId("imp-1"));
			return { ...blob, body: new TextDecoder().decode(blob.body) };
		},
	},
	{
		name: "REST GET /api/v1/messages",
		html: true,
		run: async () => {
			const response = await m.getV1Messages(
				new Request("https://kite.test/api/v1/messages?mailboxId=mailbox-a", {
					headers: { authorization: `Bearer ${API_KEY}` },
				}),
			);
			return response.json();
		},
	},
	{
		name: "assistant and MCP get_email",
		html: false,
		run: ({ env }) => m.runEmailTool(toolContext(env), "get_email", { emailId: "imp-1" }),
	},
	{
		name: "assistant and MCP get_thread",
		html: false,
		run: ({ env }) => m.runEmailTool(toolContext(env), "get_thread", { emailId: "imp-1" }),
	},
	{
		name: "automatic reading (triage context)",
		html: true,
		run: async ({ env }) => m.loadTriageContext(env, await loadRow(env), "owner"),
	},
	{
		name: "reply drafting thread (suggestions, invite proposals, auto-draft)",
		html: true,
		run: async ({ env }) => m.loadDraftThread(env, "mailbox-a", await loadRow(env)),
	},
	{
		name: "module host message text",
		html: false,
		run: ({ env }) => m.getModuleMessage(env, moduleContext, "imp-1", { text: { maxBytes: 20_000 } }),
	},
	{
		name: "module host recent mail from a sender",
		html: false,
		run: ({ env }) =>
			m.recentModuleMessagesFromSender(env, moduleContext, {
				mailboxId: "mailbox-a",
				sender: "sam@partner.test",
				before: new Date(1_790_000_050_000).toISOString(),
				sinceDays: 30,
				limit: 5,
			}),
	},
	{
		name: "remote image proxy check",
		html: false,
		run: ({ env }) => m.canProxyMessageImage(env, user, "imp-1", IMAGE, "https://kite.test"),
	},
	{
		name: "spam report training",
		html: false,
		run: async ({ env, database }) => {
			assert.equal(await m.applySpamFeedback(env, user, "imp-1", "spam"), true);
			return database.db.prepare("SELECT classification, training_tokens, reputation_keys FROM spam_feedback").all();
		},
	},
	{ name: "mbox export", html: true, run: ({ env }) => m.exportMailboxToMbox(env, "mailbox-a", "owner") },
	{
		name: "summaries (the model's prompt)",
		html: false,
		run: async ({ env }) => {
			await m.createSummary(env, user, "imp-1", { scope: "message", language: "en" });
			return modelRequests;
		},
	},
	{
		name: "Write with Kite reply source (the model's prompt)",
		html: false,
		run: async ({ env }) => {
			const stream = await m.createComposeStream(env, user, {
				mailboxId: "mailbox-a",
				mode: "write",
				instruction: "Say thanks",
				inReplyTo: "<imp-1@partner.test>",
				threadId: "thread-1",
				subject: "Re: Quarterly report",
				to: ["sam@partner.test"],
			});
			await new Response(stream).text();
			return modelRequests;
		},
	},
];

for (const variant of [
	{ label: "with a text part", text: TEXT },
	{ label: "HTML only", text: null },
])
	for (const reader of READERS)
		test(`${reader.name} reads an offloaded body like an inline one (${variant.label})`, async (t) => {
			const inline = json(await reader.run(await fixture(t, { offloaded: false, text: variant.text })));
			const offloaded = await fixture(t, { offloaded: true, text: variant.text });
			modelRequests = [];
			const answer = json(await reader.run(offloaded));
			assert.deepEqual(answer, inline);
			if (reader.html) assert.ok(JSON.stringify(answer).includes("Revenue grew in every region"), "shows the HTML");
		});

test("readers that need no HTML leave the store alone", async (t) => {
	const { env, bucket } = await fixture(t, { offloaded: true });
	await m.emailGet(jmapContext(env), {
		accountId: "owner",
		ids: ["imp-1"],
		properties: ["subject", "preview", "keywords"],
	});
	await m.runEmailTool(toolContext(env), "get_thread", { emailId: "imp-1" });
	await m.getModuleMessage(env, moduleContext, "imp-1", { text: { maxBytes: 100 } });
	assert.equal(bucket.stats.gets, 0);
	await m.getMessageWithBodyForUser(env, user, "imp-1");
	assert.equal(bucket.stats.gets, 1);
});

test("a missing object or a key that is not the message's own shows the text body", async (t) => {
	const { env, bucket, database } = await fixture(t, { offloaded: true });
	bucket.objects.delete(BODY_KEY);
	const gone = await m.getMessageWithBodyForUser(env, user, "imp-1");
	assert.equal(gone.body.htmlBody, null);
	assert.equal(gone.body.textBody, TEXT);
	// A hand-edited backup could point a message at another object; it is never read as a body.
	bucket.objects.set("attachments/other/secret", "<p>Someone else's file</p>");
	database.db.exec("UPDATE messages SET html_body_key = 'attachments/other/secret' WHERE id = 'imp-1'");
	const foreign = await m.getMessageWithBodyForUser(env, user, "imp-1");
	assert.equal(foreign.body.htmlBody, null);
	assert.equal(bucket.stats.gets, 1);
});

test("an object read that fails shows the text body instead of failing the reader", async (t) => {
	const { env, bucket } = await fixture(t, { offloaded: true });
	bucket.get = async () => {
		throw new Error("store unreachable");
	};
	const answer = await m.getMessageThreadForUser(env, user, "imp-1");
	assert.equal(answer.messages[0].htmlBody, null);
	assert.equal(answer.messages[0].textBody, TEXT);
});

/** A minimal RFC 5322 message; `html` alone makes it single-part. */
function mime({ id, html, text = null, attachment = null }) {
	const headers = [
		"From: Sam <sam@partner.test>",
		"To: alex@example.com",
		`Subject: Imported ${id}`,
		`Message-ID: <${id}@partner.test>`,
		"Date: Tue, 06 Oct 2026 09:00:00 +0000",
		"MIME-Version: 1.0",
	];
	const body = text
		? [
				'Content-Type: multipart/alternative; boundary="b"',
				"",
				"--b",
				"Content-Type: text/plain; charset=utf-8",
				"",
				text,
				"--b",
				"Content-Type: text/html; charset=utf-8",
				"",
				html,
				"--b--",
			]
		: ["Content-Type: text/html; charset=utf-8", "", html];
	const parts = attachment
		? [
				'Content-Type: multipart/mixed; boundary="mixed"',
				"",
				"--mixed",
				...body,
				"--mixed",
				'Content-Type: text/plain; name="notes.txt"',
				'Content-Disposition: attachment; filename="notes.txt"',
				"",
				attachment,
				"--mixed--",
			]
		: body;
	return new TextEncoder().encode([...headers, ...parts].join("\r\n")).buffer;
}

async function importMessages(env, list) {
	return m.importMessagesToMailbox(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		destination: { type: "system", section: "inbox" },
		messages: list.map((item) => ({ filename: `${item.id}.eml`, raw: mime(item) })),
	});
}

const stored = (database, subject) =>
	database.db
		.prepare("SELECT id, text_body, html_body, html_body_key FROM messages WHERE subject = ?")
		.get(`Imported ${subject}`);

test("the import offloads large HTML to the Mail store and keeps small HTML in the row", async (t) => {
	const { env, bucket, database } = await fixture(t, { offloaded: false });
	const result = await importMessages(env, [
		{ id: "big", html: HTML, text: TEXT },
		{ id: "html-only", html: HTML },
		{ id: "small", html: "<p>Short and sweet</p>", text: "Short and sweet" },
	]);
	assert.deepEqual(result, { imported: 3, skipped: 0, errors: [] });

	const big = stored(database, "big");
	assert.equal(big.html_body, null);
	assert.equal(big.html_body_key, `bodies/${big.id}.html`);
	assert.equal(big.text_body.trim(), TEXT);
	const html = bucket.objects.get(big.html_body_key);
	assert.ok(html.includes("Revenue grew in every region"));

	const htmlOnly = stored(database, "html-only");
	assert.equal(htmlOnly.html_body, null);
	assert.match(htmlOnly.text_body, /Revenue grew in every region/);

	const small = stored(database, "small");
	assert.equal(small.html_body_key, null);
	assert.match(small.html_body, /Short and sweet/);

	// FTS5 indexes the row: the text kept for a message without a text part is what search finds, and a message
	// with one is found by its text part (words only in its HTML part are not, by design).
	const search = (term) =>
		database.db
			.prepare(
				"SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?",
			)
			.all(term)
			.map((row) => row.id)
			.filter((id) => id !== "imp-1" && id !== "reply-1")
			.sort();
	assert.deepEqual(search("figures"), [htmlOnly.id]);
	assert.deepEqual(search("agenda"), [big.id, htmlOnly.id].sort());

	// Read back, the imported message shows the HTML it was imported with.
	const reader = await m.getMessageWithBodyForUser(env, user, htmlOnly.id);
	assert.equal(reader.body.htmlBody, html);
	assert.equal(reader.body.textBody, null);
});

test("before migration 0074 the import keeps the HTML in the row and readers keep working", async (t) => {
	const before = copyMigrationsBefore(directory, 74);
	const { env, bucket, database } = await fixture(t, { offloaded: false, migrations: before });
	assert.equal(await m.canOffloadHtmlBodies(env), false);
	await importMessages(env, [{ id: "big", html: HTML, text: TEXT }]);
	const row = database.db.prepare("SELECT id, html_body FROM messages WHERE subject = 'Imported big'").get();
	assert.ok(row.html_body.includes("Revenue grew in every region"));
	assert.equal(
		[...bucket.objects.keys()].some((key) => key.startsWith("bodies/")),
		false,
	);
	const thread = await m.getMessageThreadForUser(env, user, "reply-1");
	assert.equal(thread.messages.length, 2);
	const textOnly = await m.loadMessageBodies(env, [{ id: "reply-1", htmlBody: null, textBody: "Thanks, Sam." }]);
	assert.equal(textOnly[0].htmlBody, null);
});

test("deleting a message deletes its offloaded body, whichever path deletes it", async (t) => {
	const { env, bucket, database } = await fixture(t, { offloaded: false });
	await importMessages(env, [
		{ id: "one", html: HTML, text: TEXT },
		{ id: "two", html: HTML, text: TEXT },
		{ id: "three", html: HTML, text: TEXT },
	]);
	const [one, two, three] = ["one", "two", "three"].map((id) => stored(database, id));
	for (const row of [one, two, three]) assert.ok(bucket.objects.has(`bodies/${row.id}.html`));

	await m.deleteMessageWithObjects(env, m.getDb(env), one.id, null);
	assert.equal(bucket.objects.has(`bodies/${one.id}.html`), false);

	await m.permanentlyDeleteMessages(
		env,
		m.getDb(env),
		"owner",
		[{ id: two.id, mailboxId: "mailbox-a", rawR2Key: null, status: "trash" }],
		"bulk",
	);
	assert.equal(bucket.objects.has(`bodies/${two.id}.html`), false);

	env.OUTBOUND_QUEUE = { send: async () => {} };
	assert.equal((await m.deleteMailboxWithContents(env, "mailbox-a")).completed, true);
	assert.equal(bucket.objects.has(`bodies/${three.id}.html`), false);
	assert.equal(
		[...bucket.objects.keys()].some((key) => key.startsWith("bodies/")),
		false,
	);
});

test("a backup keeps the body key and a restore reads the body from the store again", async (t) => {
	const source = await fixture(t, { offloaded: true });
	const document = await m.exportDatabaseRecords(source.database);
	const parsed = JSON.parse(new TextDecoder().decode(document));
	const record = parsed.tables.messages.find((row) => row.id === "imp-1");
	assert.equal(record.html_body_key, BODY_KEY);
	assert.equal(record.html_body, null);
	assert.ok(!JSON.stringify(parsed).includes("Revenue grew in every region"), "the backup carries no body object");

	const target = await fixture(t, { offloaded: false });
	await m.restoreDatabaseRecords(
		target.database,
		document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength),
	);
	target.bucket.objects.set(BODY_KEY, HTML);
	const restored = await m.getMessageWithBodyForUser(target.env, user, "imp-1");
	assert.equal(restored.body.htmlBody, HTML);
});

test("an import that fails between its steps leaves no row without its HTML", async (t) => {
	const { env, bucket, database } = await fixture(t, { offloaded: false });
	const bodies = () => [...bucket.objects.keys()].filter((key) => key.startsWith("bodies/"));
	const imported = () =>
		database.db.prepare("SELECT count(*) AS n FROM messages WHERE subject LIKE 'Imported %'").get().n;

	// The object write fails: nothing is stored.
	const put = bucket.put;
	bucket.put = async (key, value, options) => {
		if (key.startsWith("bodies/")) throw new Error("store unreachable");
		return put(key, value, options);
	};
	let result = await importMessages(env, [{ id: "put-fails", html: HTML, text: TEXT }]);
	assert.equal(result.imported, 0);
	assert.equal(imported(), 0);
	bucket.put = put;

	// Recording the key fails after the insert ran: the batch rolls the insert back, so no row lacks its HTML,
	// and the object written first is removed (a crash at this point would leave only that orphan object).
	database.db.exec(
		"CREATE TRIGGER crash_on_key BEFORE UPDATE OF html_body_key ON messages BEGIN SELECT RAISE(ABORT, 'simulated crash'); END",
	);
	result = await importMessages(env, [{ id: "key-fails", html: HTML, text: TEXT }]);
	assert.equal(result.imported, 0);
	assert.match(result.errors[0], /simulated crash/);
	assert.equal(imported(), 0);
	assert.deepEqual(bodies(), []);
	database.db.exec("DROP TRIGGER crash_on_key");

	// A later write fails while another is still running: cleanup waits for both, so nothing lands afterwards.
	bucket.put = async (key, value, options) => {
		if (key.startsWith("attachments/")) throw new Error("attachment write failed");
		if (key.startsWith("imports/")) await new Promise((resolve) => setTimeout(resolve, 50));
		return put(key, value, options);
	};
	result = await importMessages(env, [{ id: "late-fails", html: HTML, text: TEXT, attachment: "Meeting notes" }]);
	assert.equal(result.imported, 0);
	// Long enough for a write still running after an early cleanup to land.
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(imported(), 0);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM message_attachments").get().n, 0);
	assert.deepEqual(
		[...bucket.objects.keys()].filter((key) => /^(bodies|imports|attachments)\//.test(key)),
		[],
		"no object outlives the failed import",
	);
	bucket.put = put;

	// With nothing failing, the same message imports with its key and size recorded together.
	result = await importMessages(env, [{ id: "works", html: HTML, text: TEXT, attachment: "Meeting notes" }]);
	assert.equal(result.imported, 1);
	const row = database.db
		.prepare("SELECT id, html_body, html_body_key, body_size FROM messages WHERE subject = 'Imported works'")
		.get();
	assert.equal(row.html_body, null);
	assert.equal(row.html_body_key, `bodies/${row.id}.html`);
	assert.ok(bucket.objects.has(row.html_body_key));
	assert.ok(row.body_size > Buffer.byteLength(HTML) - 100, "the size counts the HTML in bytes");
});

test("the mbox export fails visibly when a body cannot be read, and reads many bodies in pages", async (t) => {
	const { env, bucket, database } = await fixture(t, { offloaded: true });
	const insert = database.db.prepare(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, html_body_key, body_size, created_at)
		VALUES (?, 'owner', 'mailbox-a', 'inbound', 'sam@partner.test', 'alex@example.com', 'Bulk', 'Bulk text', 'received', ?, 1, ?)`,
	);
	for (let index = 0; index < 230; index++) {
		const id = `bulk-${String(index).padStart(3, "0")}`;
		insert.run(id, `bodies/${id}.html`, 1_790_001_000 + index);
		bucket.objects.set(`bodies/${id}.html`, `<p>Bulk body ${id}</p>`);
	}
	const mbox = await m.exportMailboxToMbox(env, "mailbox-a", "owner");
	assert.equal(mbox.match(/^From MAILER-DAEMON/gm).length, 232);
	assert.ok(mbox.includes("Revenue grew in every region"));
	for (const id of ["bulk-000", "bulk-099", "bulk-100", "bulk-229"]) assert.ok(mbox.includes(`Bulk body ${id}`), id);

	const get = bucket.get;
	bucket.get = async (key) => {
		if (key === "bodies/bulk-150.html") throw new Error("store unreachable");
		return get(key);
	};
	await assert.rejects(m.exportMailboxToMbox(env, "mailbox-a", "owner"), (error) => {
		assert.ok(error instanceof m.MessageBodyUnavailableError);
		assert.equal(error.messageId, "bulk-150");
		return true;
	});
	// The reader still shows the text body for the same failure.
	bucket.get = async () => {
		throw new Error("store unreachable");
	};
	assert.equal((await m.getMessageWithBodyForUser(env, user, "imp-1")).body.htmlBody, null);
});

for (const variant of [
	{ label: "with a text part", text: TEXT },
	{ label: "HTML only", text: null },
])
	test(`JMAP Email/query sizes agree with Email/get for an offloaded message (${variant.label})`, async (t) => {
		const sizes = [];
		for (const offloaded of [false, true]) {
			const { env, database } = await fixture(t, { offloaded, text: variant.text });
			database.db.exec(
				"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att-1', 'imp-1', 'notes.txt', 'text/plain', 1234, 'attachments/imp-1/0', 1)",
			);
			const ctx = jmapContext(env);
			const got = await m.emailGet(ctx, { accountId: "owner", ids: ["imp-1", "reply-1"], properties: ["size"] });
			const size = Object.fromEntries(got.list.map((email) => [email.id, email.size]));
			sizes.push(size);
			const query = async (args) => (await m.emailQuery(ctx, { accountId: "owner", ...args })).ids;
			assert.deepEqual(await query({ filter: { minSize: size["imp-1"], maxSize: size["imp-1"] + 1 } }), ["imp-1"]);
			assert.deepEqual(await query({ filter: { minSize: size["imp-1"] + 1 } }), []);
			assert.deepEqual(await query({ filter: { maxSize: size["imp-1"] } }), ["reply-1"]);
			assert.deepEqual(await query({ sort: [{ property: "size", isAscending: true }] }), ["reply-1", "imp-1"]);
			// The body filter reads the text D1 keeps: the text part, or the readable text of HTML-only mail.
			assert.deepEqual(await query({ filter: { body: "agenda" } }), ["imp-1"]);
		}
		assert.deepEqual(sizes[1], sizes[0]);
		assert.ok(sizes[0]["imp-1"] > Buffer.byteLength(HTML) + 1234 - 1, "bytes, attachments included");
	});
