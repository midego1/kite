import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-module-host-services-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		host: join(root, "src/lib/modules/host.ts"),
		invoke: join(root, "src/lib/modules/invoke.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { moduleHost } = await load("host");
await load("invoke");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const START = Date.parse("2030-03-12T10:00:00.000Z");
const DAY = 86_400;

const ctx = (userId, extra = {}) => ({
	viewer: userId ? { userId, role: "user", isPrimaryAdmin: false } : null,
	requestId: "req-1",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "api",
	...extra,
});

const invitePayload = () => ({
	uid: "uid-1@partner.test",
	sequence: 0,
	method: "REQUEST",
	organizer: "alice@partner.test",
	start: new Date(START).toISOString(),
	end: new Date(START + 3_600_000).toISOString(),
	tz: "UTC",
	summary: "Planning",
	location: null,
	repeats: false,
	conflicts: [],
	proposals: [],
	organizerMatchesSender: true,
	authPassed: true,
	existingEventId: null,
});

const RAW = [
	"From: Vendor Billing <billing@vendor.example>",
	"To: support@example.com",
	"Subject: Your receipt",
	"List-Unsubscribe: <https://vendor.example/unsubscribe>",
	"List-Id: Vendor news <news.vendor.example>",
	"",
	"Thanks",
].join("\r\n");

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const now = 1_900_000_000;
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1),
			('reader', 'reader@example.com', 'hash', 'Reader', 1),
			('stranger', 'stranger@example.com', 'hash', 'Stranger', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'support', 'shared', 1),
			('mailbox-b', 'owner', 'domain-1', 'other', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('access-1', 'mailbox-a', 'member', 'full_access', 1),
			('access-2', 'mailbox-a', 'reader', 'read_only', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, html_body, raw_r2_key, status, created_at) VALUES
			('receipt', 'owner', 'mailbox-a', 'inbound', 'Vendor Billing <billing@vendor.example>', 'support@example.com', 'Your receipt', 'Total 17,99 €', NULL, 'raw/receipt', 'received', ${now}),
			('older-1', 'owner', 'mailbox-a', 'inbound', 'billing@vendor.example', 'support@example.com', 'March', NULL, '<p>Paid <b>17,99 €</b></p>', NULL, 'received', ${now - 30 * DAY}),
			('older-2', 'owner', 'mailbox-a', 'inbound', 'BILLING@vendor.example', 'support@example.com', 'February', '${"é".repeat(3000)}', NULL, NULL, 'trash', ${now - 60 * DAY}),
			('too-old', 'owner', 'mailbox-a', 'inbound', 'billing@vendor.example', 'support@example.com', 'Ancient', 'x', NULL, NULL, 'received', ${now - 500 * DAY}),
			('lookalike', 'owner', 'mailbox-a', 'inbound', 'x.billing@vendor.example', 'support@example.com', 'Other', 'x', NULL, NULL, 'received', ${now - 10 * DAY}),
			('sent', 'owner', 'mailbox-a', 'outbound', 'billing@vendor.example', 'support@example.com', 'Outbound', 'x', NULL, NULL, 'sent', ${now - 5 * DAY}),
			('elsewhere', 'owner', 'mailbox-b', 'inbound', 'billing@vendor.example', 'other@example.com', 'Other box', 'x', NULL, NULL, 'received', ${now - 5 * DAY}),
			('source-1', 'owner', 'mailbox-a', 'inbound', 'Alice <alice@partner.test>', 'support@example.com', 'Planning', 'Join us', NULL, NULL, 'received', 1);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES
			('att-1', 'older-1', 'invoice.pdf', 'application/pdf', 1200, 'att/1', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES
			('contact-1', 'owner', 'billing@vendor.example', 'Vendor Billing', 'inbound', 1),
			('contact-2', 'member', 'billing@vendor.example', 'Member copy', 'inbound', 1);
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES
			('sugg-1', 'mailbox-a', 'source-1', 'owner', 'calendar_invite', 'open', 'Invitation', '${JSON.stringify(invitePayload())}', 1),
			('sugg-closed', 'mailbox-a', 'receipt', 'owner', 'calendar_invite', 'dismissed', 'Invitation', '{}', 1),
			('sugg-reply', 'mailbox-a', 'source-1', 'owner', 'reply', 'open', 'Reply', '{}', 1);
	`);
	const objects = new Map([["raw/receipt", new TextEncoder().encode(RAW)]]);
	const notices = [];
	const env = {
		DB: db,
		BUCKET: {
			put: async (key, value) => void objects.set(key, value),
			get: async (key) => {
				const value = objects.get(key);
				return value ? { size: value.byteLength, arrayBuffer: async () => value.buffer } : null;
			},
			delete: async (key) => void objects.delete(key),
		},
		REALTIME: {
			getByName: (userId) => ({
				fetch: async (_url, init) => {
					notices.push({ userId, payload: JSON.parse(init.body) });
					return new Response(null, { status: 204 });
				},
			}),
		},
		OUTBOUND_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		clearModuleStateCache();
	});
	return { db, env, notices, now };
}

test("every new ModuleHost service is a bound function", () => {
	for (const path of [
		"suggestions.get",
		"suggestions.decide",
		"actions.execute",
		"notify",
		"contacts.find",
		"mail.getMessage",
		"mail.recentFromSender",
	]) {
		const value = path.split(".").reduce((target, key) => target[key], moduleHost);
		assert.equal(typeof value, "function", path);
	}
});

test("getMessage adds the sender name, a byte-bounded excerpt and only the asked-for list headers", async (t) => {
	await setup(t);
	const plain = await moduleHost.mail.getMessage(ctx("owner"), "receipt");
	assert.equal(plain.fromName, "Vendor Billing");
	assert.equal("textExcerpt" in plain, false);
	assert.equal("headers" in plain, false);
	const full = await moduleHost.mail.getMessage(ctx("reader"), "receipt", {
		text: { maxBytes: 12 },
		headers: ["list-unsubscribe", "list-unsubscribe-post"],
	});
	assert.equal(full.textExcerpt, "Total 17,99 ");
	assert.deepEqual(full.headers, {
		"list-unsubscribe": "<https://vendor.example/unsubscribe>",
		"list-unsubscribe-post": null,
	});
	const html = await moduleHost.mail.getMessage(ctx("owner"), "older-1", {
		text: { maxBytes: 100 },
		headers: ["list-id"],
	});
	assert.match(html.textExcerpt, /Paid\s+17,99 €/);
	assert.deepEqual(html.headers, { "list-id": null }, "no raw message means no headers");
	assert.equal(html.fromName, null);
	assert.equal(await moduleHost.mail.getMessage(ctx("stranger"), "receipt", { text: { maxBytes: 100 } }), null);
	await assert.rejects(() => moduleHost.mail.getMessage(ctx(null), "receipt"), /acting user/);
});

test("recentFromSender lists earlier received mail from the exact sender in a bound mailbox, newest first", async (t) => {
	const { now } = await setup(t);
	const query = {
		mailboxId: "mailbox-a",
		sender: "billing@vendor.example",
		before: new Date(now * 1000).toISOString(),
		sinceDays: 400,
		limit: 5,
	};
	const bound = (userId) => ctx(userId, { mailboxIds: ["mailbox-a"] });
	const found = await moduleHost.mail.recentFromSender(bound("owner"), query);
	assert.deepEqual(
		found.map((item) => item.id),
		["older-1", "older-2"],
	);
	assert.match(found[0].textExcerpt, /Paid/);
	assert.deepEqual(
		found[0].attachments.map((item) => item.id),
		["att-1"],
	);
	assert.ok(new TextEncoder().encode(found[1].textExcerpt).length <= 4096);
	assert.equal(found[1].textExcerpt.length, 2048, "two-byte characters fill exactly 4 KB");
	assert.deepEqual(
		(await moduleHost.mail.recentFromSender(bound("owner"), { ...query, limit: 1 })).map((item) => item.id),
		["older-1"],
	);
	assert.equal((await moduleHost.mail.recentFromSender(bound("owner"), { ...query, sinceDays: 1000 })).length, 3);
	assert.equal((await moduleHost.mail.recentFromSender(bound("reader"), query)).length, 2, "read access is enough");
	assert.deepEqual(await moduleHost.mail.recentFromSender(bound("stranger"), query), []);
	assert.deepEqual(await moduleHost.mail.recentFromSender(ctx("owner"), query), [], "the call must be bound to it");
	assert.deepEqual(
		await moduleHost.mail.recentFromSender(ctx("owner", { mailboxIds: ["mailbox-b"] }), query),
		[],
		"a different bound mailbox is refused",
	);
	assert.deepEqual(await moduleHost.mail.recentFromSender(bound("owner"), { ...query, sender: "not an address" }), []);
	await assert.rejects(
		() => moduleHost.mail.recentFromSender(ctx(null, { mailboxIds: ["mailbox-a"] }), query),
		/acting user/,
	);
});

test("contacts.find returns only the viewer's own contact for an address", async (t) => {
	await setup(t);
	assert.deepEqual(await moduleHost.contacts.find(ctx("owner"), "owner", "Billing <BILLING@vendor.example>"), {
		id: "contact-1",
		displayName: "Vendor Billing",
	});
	assert.deepEqual(await moduleHost.contacts.find(ctx("member"), "member", "billing@vendor.example"), {
		id: "contact-2",
		displayName: "Member copy",
	});
	assert.equal(await moduleHost.contacts.find(ctx("member"), "owner", "billing@vendor.example"), null);
	assert.equal(await moduleHost.contacts.find(ctx(null), "owner", "billing@vendor.example"), null);
	assert.equal(await moduleHost.contacts.find(ctx("owner"), "owner", "nobody@vendor.example"), null);
	assert.equal(await moduleHost.contacts.find(ctx("owner"), "owner", ""), null);
});

test("notify sends a cleaned notice only to users with the module on and refuses a foreign link", async (t) => {
	const { db, notices } = await setup(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at, updated_by) VALUES ('ua-1', 'member', 'finance', 0, 1, 'owner')",
	);
	clearModuleStateCache();
	await moduleHost.notify(ctx(null, { trigger: "cron" }), "finance", ["owner", "member", "owner", "missing"], {
		notice: "renewal_due",
		title: `Renews soon ${"x".repeat(200)}`,
		body: "In 3 days",
		href: "/finance?subscription=s1",
	});
	assert.equal(notices.length, 1);
	assert.equal(notices[0].userId, "owner");
	assert.equal(notices[0].payload.type, "module_notice");
	assert.equal(notices[0].payload.moduleId, "finance");
	assert.equal(notices[0].payload.notice, "renewal_due");
	assert.equal(Array.from(notices[0].payload.title).length, 120);
	assert.equal(notices[0].payload.body, "In 3 days");
	assert.equal(notices[0].payload.href, "/finance?subscription=s1");
	await assert.rejects(
		() => moduleHost.notify(ctx(null), "finance", ["owner"], { notice: "n", title: "t", href: "https://evil.test" }),
		/same-origin/,
	);
	assert.equal(notices.length, 1);
	db.db.exec("INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES ('finance', 'finance', 0, 1)");
	clearModuleStateCache();
	await moduleHost.notify(ctx(null), "finance", ["owner"], { notice: "n", title: "t" });
	assert.equal(notices.length, 1, "nobody gets a notice of a module that is off");
});

test("suggestions.get answers only the owning module and viewers with full access to the bound mailbox", async (t) => {
	await setup(t);
	const got = await moduleHost.suggestions.get(ctx("owner"), "calendar", "sugg-1");
	assert.equal(got.kind, "calendar_invite");
	assert.equal(got.status, "open");
	assert.equal(got.mailboxId, "mailbox-a");
	assert.equal(got.messageId, "source-1");
	assert.equal(got.reviewerUserId, "owner");
	assert.equal(got.payload.uid, "uid-1@partner.test");
	assert.equal((await moduleHost.suggestions.get(ctx("member"), "calendar", "sugg-1")).id, "sugg-1");
	assert.equal((await moduleHost.suggestions.get(ctx("owner"), "calendar", "sugg-closed")).status, "dismissed");
	assert.equal(await moduleHost.suggestions.get(ctx("owner"), "finance", "sugg-1"), null, "another module's kind");
	assert.equal(await moduleHost.suggestions.get(ctx("owner"), "calendar", "sugg-reply"), null, "a core kind");
	assert.equal(await moduleHost.suggestions.get(ctx("reader"), "calendar", "sugg-1"), null, "read-only access");
	assert.equal(await moduleHost.suggestions.get(ctx("stranger"), "calendar", "sugg-1"), null);
	assert.equal(await moduleHost.suggestions.get(ctx(null), "calendar", "sugg-1"), null);
	assert.equal(
		await moduleHost.suggestions.get(ctx("owner", { mailboxIds: ["mailbox-b"] }), "calendar", "sugg-1"),
		null,
	);
	assert.equal(await moduleHost.suggestions.get(ctx("owner"), "calendar", "missing"), null);
});

test("suggestions.decide accepts an open suggestion once, for the viewer, and pings full-access users", async (t) => {
	const { db, notices } = await setup(t);
	assert.equal(await moduleHost.suggestions.decide(ctx("reader"), "calendar", "sugg-1", "accepted"), false);
	assert.equal(await moduleHost.suggestions.decide(ctx("owner"), "finance", "sugg-1", "accepted"), false);
	assert.equal(await moduleHost.suggestions.decide(ctx("owner"), "calendar", "sugg-1", "dismissed"), false);
	assert.equal(notices.length, 0);
	assert.equal(await moduleHost.suggestions.decide(ctx("member"), "calendar", "sugg-1", "accepted"), true);
	const row = db.db
		.prepare("SELECT status, decided_by_user_id, decided_at FROM agent_suggestions WHERE id = 'sugg-1'")
		.get();
	assert.equal(row.status, "accepted");
	assert.equal(row.decided_by_user_id, "member");
	assert.ok(row.decided_at);
	assert.deepEqual(notices.map((item) => item.userId).sort(), ["member", "owner"]);
	assert.equal(notices[0].payload.type, "agent_suggestion");
	assert.equal(
		await moduleHost.suggestions.decide(ctx("owner"), "calendar", "sugg-1", "accepted"),
		false,
		"no longer open",
	);
	assert.equal(await moduleHost.suggestions.decide(ctx("owner"), "calendar", "sugg-closed", "accepted"), false);
});

const createEventCall = (extra = {}) => ({
	capability: "createEvent",
	mailboxId: "mailbox-a",
	suggestionId: "sugg-1",
	input: { variant: "", payload: invitePayload(), reviewerUserId: "owner", messageId: "source-1" },
	...extra,
});

test("actions.execute runs the module's own action as the viewer and is idempotent", async (t) => {
	const { db } = await setup(t);
	const first = await moduleHost.actions.execute(ctx("owner"), "calendar", createEventCall());
	assert.equal(first.ok, true);
	assert.match(first.actionId, /^aact_/);
	assert.ok(first.result.eventId);
	const [row] = db.db.prepare("SELECT * FROM agent_actions").all();
	assert.equal(row.action, "create_event");
	assert.equal(row.initiator, "user");
	assert.equal(row.acting_user_id, "owner");
	assert.equal(row.status, "applied");
	assert.equal(row.message_id, "source-1", "the message comes from the suggestion");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	const again = await moduleHost.actions.execute(ctx("owner"), "calendar", createEventCall());
	assert.deepEqual(again, { ok: true, actionId: first.actionId, result: first.result });
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
});

test("actions.execute refuses foreign, unknown and unreachable calls with 403, 404 and 409", async (t) => {
	const { db } = await setup(t);
	const run = (userId, moduleId, extra, context = {}) =>
		moduleHost.actions.execute(ctx(userId, context), moduleId, createEventCall(extra));
	assert.deepEqual(await run("owner", "finance", {}), {
		ok: false,
		status: 403,
		error: "This action belongs to another module",
	});
	assert.equal((await run("owner", "calendar", { capability: "invite" })).status, 404);
	assert.equal((await run("owner", "calendar", { capability: "nothing" })).status, 404);
	assert.equal((await run(null, "calendar", {})).status, 403);
	assert.equal((await run("stranger", "calendar", {})).status, 404);
	assert.equal((await run("owner", "calendar", {}, { mailboxIds: ["mailbox-b"] })).status, 404);
	assert.equal(
		(await run("owner", "calendar", { mailboxId: "mailbox-b" })).status,
		404,
		"suggestion outside the mailbox",
	);
	assert.equal((await run("owner", "calendar", { suggestionId: "sugg-reply" })).status, 404, "a kind it does not own");
	assert.equal((await run("owner", "calendar", { suggestionId: null, messageId: "elsewhere" })).status, 404);
	assert.equal((await run("reader", "calendar", { suggestionId: null })).status, 403, "read-only cannot manage");
	assert.equal((await run("owner", "calendar", { variant: "bogus" })).status, 409);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	clearModuleStateCache();
	const off = await run("owner", "calendar", {});
	assert.equal(off.ok, false);
	assert.equal(off.status, 409);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM agent_actions WHERE status <> 'blocked'").get().n, 0);
});
