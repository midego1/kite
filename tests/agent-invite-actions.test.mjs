import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-invite-actions-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		invite: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/invite-actions.ts")),
		execute: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/execute.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { acceptInvite } = await load("invite");
const { undoAgentAction } = await load("execute");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const START = Date.parse("2030-03-12T10:00:00.000Z");
const full = { canManage: true, canSendOnBehalf: true };
const user = { id: "owner", role: "user", isPrimaryAdmin: false, timeZone: "UTC", undoSendSeconds: 0 };

function payload(extra = {}) {
	return {
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
		proposals: [
			{
				start: new Date(START + 86_400_000).toISOString(),
				end: new Date(START + 86_400_000 + 3_600_000).toISOString(),
			},
			{
				start: new Date(START + 2 * 86_400_000).toISOString(),
				end: new Date(START + 2 * 86_400_000 + 3_600_000).toISOString(),
			},
		],
		organizerMatchesSender: true,
		authPassed: true,
		existingEventId: null,
		...extra,
	};
}

async function setup(t, { undoSendSeconds = 0 } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('source-1', 'owner', 'mailbox-a', 'inbound', '<source-1@partner.test>', 'Alice <alice@partner.test>', 'support@example.com', 'Planning', 'Join us', 'received', 1);
	`);
	db.db.prepare("UPDATE users SET undo_send_seconds = ?").run(undoSendSeconds);
	const objects = new Map();
	const sent = [];
	const queued = [];
	const env = {
		DB: db,
		BUCKET: {
			put: async (key, value) => void objects.set(key, value),
			get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
			delete: async (key) => void objects.delete(key),
		},
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: `<sent-${sent.length}@cf.test>` };
			},
		},
		OUTBOUND_QUEUE: { send: async (message) => void queued.push(message) },
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	return { db, env, sent, queued, user: { ...user, undoSendSeconds } };
}

function addSuggestion(db, id, suggestionPayload, status = "open") {
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES (?, 'mailbox-a', 'source-1', 'owner', 'calendar_invite', ?, 'Invitation', ?, 1)",
		)
		.run(id, status, JSON.stringify(suggestionPayload));
}

const row = (status = "open", id = "sugg-1") => ({ id, mailboxId: "mailbox-a", messageId: "source-1", status });
const events = (db) => db.db.prepare("SELECT * FROM calendar_events ORDER BY created_at").all();
const actions = (db, where = "1 = 1") =>
	db.db.prepare(`SELECT * FROM agent_actions WHERE ${where} ORDER BY rowid`).all();
const suggestion = (db, id = "sugg-1") => db.db.prepare("SELECT * FROM agent_suggestions WHERE id = ?").get(id);
const outbound = (db) => db.db.prepare("SELECT * FROM messages WHERE direction = 'outbound' ORDER BY rowid").all();

async function answer(ctx, option, status) {
	const current = status ?? suggestion(ctx.db).status;
	return acceptInvite(ctx.env, ctx.user, full, row(current), option);
}

function rsvpFile(message) {
	const [attachment] = message.attachments;
	assert.equal(attachment.filename, "invite.ics");
	assert.match(attachment.type, /^text\/calendar/);
	return typeof attachment.content === "string"
		? attachment.content
		: Buffer.from(attachment.content, "base64").toString();
}

test("accept creates one event for the reviewer and sends one ACCEPTED reply to the organizer only", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	const result = await answer(ctx, "accept");
	assert.equal(result.status, "accepted");
	const [event, ...more] = events(ctx.db);
	assert.equal(more.length, 0);
	assert.equal(event.user_id, "owner");
	assert.equal(event.title, "Planning");
	assert.equal(event.status, "confirmed");
	assert.equal(event.ical_uid, "uid-1@partner.test");
	assert.equal(event.ical_sequence, 0);
	assert.equal(event.organizer, "alice@partner.test");
	assert.equal(event.source_message_id, "source-1");
	assert.equal(event.mailbox_id, null);
	assert.equal(ctx.sent.length, 1);
	const [message] = ctx.sent;
	assert.deepEqual([message.to].flat(), ["alice@partner.test"]);
	assert.equal(message.cc?.length ?? 0, 0);
	assert.equal(message.bcc?.length ?? 0, 0);
	const ics = rsvpFile(message);
	assert.match(ics, /METHOD:REPLY/);
	assert.match(ics, /ATTENDEE;PARTSTAT=ACCEPTED:mailto:support@example\.com/);
	assert.match(ics, /UID:uid-1@partner\.test\r\n/);
	assert.doesNotMatch(ics, /@mailflare/);
	assert.match(ics, /SEQUENCE:0/);
	assert.deepEqual(
		actions(ctx.db).map((action) => [action.action, action.variant, action.status, action.initiator]),
		[
			["create_event", "", "applied", "user"],
			["send_rsvp", "accepted", "applied", "user"],
		],
	);
	assert.equal(suggestion(ctx.db).status, "accepted");
});

test("a repeated accept is refused and adds no event or message", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	await assert.rejects(answer(ctx, "accept"), (error) => error.status === 409);
	// A stale client still showing the card as open is answered by the executor's idempotency, never a second effect.
	const stale = await answer(ctx, "accept", "open");
	assert.equal(stale.status, "accepted");
	assert.equal(events(ctx.db).length, 1);
	assert.equal(ctx.sent.length, 1);
});

test("two concurrent accepts run each effect once", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	const settled = await Promise.allSettled([answer(ctx, "accept", "open"), answer(ctx, "accept", "open")]);
	assert.equal(events(ctx.db).length, 1);
	assert.equal(ctx.sent.length, 1);
	assert.equal(settled.filter((result) => result.status === "fulfilled").length >= 1, true);
});

test("decline sends DECLINED and creates no event, then accept_instead creates it once", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "decline");
	assert.equal(events(ctx.db).length, 0);
	assert.match(rsvpFile(ctx.sent[0]), /PARTSTAT=DECLINED/);
	await assert.rejects(answer(ctx, "decline_instead"), (error) => error.status === 409);
	await answer(ctx, "accept_instead");
	assert.equal(events(ctx.db).length, 1);
	assert.match(rsvpFile(ctx.sent[1]), /PARTSTAT=ACCEPTED/);
	await assert.rejects(answer(ctx, "accept_instead"), (error) => error.status === 409);
	assert.equal(ctx.sent.length, 2);
	assert.equal(actions(ctx.db, "action = 'send_rsvp' AND status = 'applied'").length, 1);
});

test("accept, decline_instead and accept_instead each run once: one event, three replies, one live reply row", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	await assert.rejects(answer(ctx, "accept_instead"), (error) => error.status === 409);
	await answer(ctx, "decline_instead");
	assert.equal(events(ctx.db).length, 0);
	await assert.rejects(answer(ctx, "decline_instead"), (error) => error.status === 409);
	await answer(ctx, "accept_instead");
	assert.equal(events(ctx.db).length, 1);
	await assert.rejects(answer(ctx, "accept_instead"), (error) => error.status === 409);

	assert.equal(ctx.sent.length, 3);
	assert.deepEqual(
		ctx.sent.map((message) => /PARTSTAT=(\w+)/.exec(rsvpFile(message))[1]),
		["ACCEPTED", "DECLINED", "ACCEPTED"],
	);
	assert.equal(new Set(outbound(ctx.db).map((message) => message.id)).size, 3);
	const live = actions(ctx.db, "action = 'send_rsvp' AND status = 'applied'");
	assert.deepEqual(
		live.map((action) => action.variant),
		["accepted"],
	);
	assert.equal(actions(ctx.db, "action = 'send_rsvp' AND status = 'undone'").length, 2);
	assert.equal(suggestion(ctx.db).status, "accepted");
});

test("undo after the reply was sent removes the event and keeps the reply; decline_instead then needs no delete", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	const [created] = actions(ctx.db, "action = 'create_event'");
	await undoAgentAction(ctx.env, user, created.id);
	assert.equal(events(ctx.db).length, 0);
	assert.equal(actions(ctx.db, "id = ?".replace("?", `'${created.id}'`))[0].status, "undone");
	assert.equal(actions(ctx.db, "action = 'send_rsvp'")[0].status, "applied");
	assert.equal(suggestion(ctx.db).status, "accepted");

	await answer(ctx, "decline_instead");
	assert.equal(actions(ctx.db, "action = 'delete_event' AND variant = ''").length, 0);
	await answer(ctx, "accept_instead");
	assert.equal(events(ctx.db).length, 1);
	assert.equal(ctx.sent.length, 3);
	assert.equal(actions(ctx.db, "action = 'send_rsvp' AND status = 'applied'").length, 1);
});

test("undo while the reply is still queued deletes the event, cancels the reply and reopens the suggestion", async (t) => {
	const ctx = await setup(t, { undoSendSeconds: 30 });
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	assert.equal(ctx.sent.length, 0);
	assert.equal(ctx.queued.length, 1);
	assert.equal(outbound(ctx.db)[0].status, "queued");
	const [created] = actions(ctx.db, "action = 'create_event'");
	await undoAgentAction(ctx.env, user, created.id);

	assert.equal(events(ctx.db).length, 0);
	assert.deepEqual(
		actions(ctx.db, "variant NOT LIKE 'undo:%'").map((action) => [action.action, action.status]),
		[
			["create_event", "undone"],
			["send_rsvp", "undone"],
		],
	);
	assert.equal(outbound(ctx.db)[0].status, "draft");
	assert.equal(ctx.db.db.prepare("SELECT status FROM outbound_jobs").get().status, "cancelled");
	assert.equal(suggestion(ctx.db).status, "open");
	await answer(ctx, "accept");
	assert.equal(events(ctx.db).length, 1);
});

test("a lower SEQUENCE never overwrites the stored event, a higher one updates it, and undo restores it", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload({ sequence: 1 }));
	await answer(ctx, "accept");
	const [stored] = events(ctx.db);

	ctx.db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('source-2', 'owner', 'mailbox-a', 'inbound', 'alice@partner.test', 'support@example.com', 'Moved', 'received', 2)",
		)
		.run();
	const lower = payload({
		sequence: 0,
		summary: "Older",
		existingEventId: stored.id,
		start: new Date(START + 7_200_000).toISOString(),
		end: new Date(START + 10_800_000).toISOString(),
	});
	ctx.db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES ('sugg-lower', 'mailbox-a', 'source-2', 'owner', 'calendar_invite', 'open', 'Update', ?, 2)",
		)
		.run(JSON.stringify(lower));
	await assert.rejects(
		acceptInvite(
			ctx.env,
			ctx.user,
			full,
			{ id: "sugg-lower", mailboxId: "mailbox-a", messageId: "source-2", status: "open" },
			"update",
		),
		(error) => error.status === 409,
	);
	const unchanged = events(ctx.db)[0];
	assert.equal(unchanged.title, "Planning");
	assert.equal(unchanged.starts_at, stored.starts_at);

	ctx.db.db
		.prepare("UPDATE agent_suggestions SET payload = ? WHERE id = 'sugg-lower'")
		.run(JSON.stringify({ ...lower, sequence: 2, summary: "Planning v2" }));
	await acceptInvite(
		ctx.env,
		ctx.user,
		full,
		{ id: "sugg-lower", mailboxId: "mailbox-a", messageId: "source-2", status: "open" },
		"update",
	);
	const updated = events(ctx.db);
	assert.equal(updated.length, 1);
	assert.equal(updated[0].title, "Planning v2");
	assert.equal(updated[0].ical_sequence, 2);
	assert.equal(updated[0].starts_at, Math.floor((START + 7_200_000) / 1000));

	const [update] = actions(ctx.db, "action = 'create_event' AND variant = 'update' AND status = 'applied'");
	await undoAgentAction(ctx.env, user, update.id);
	const restored = events(ctx.db)[0];
	assert.equal(restored.title, "Planning");
	assert.equal(restored.ical_sequence, 1);
	assert.equal(restored.starts_at, stored.starts_at);
	assert.equal(ctx.sent.length, 1);
});

test("remove deletes the event and undo recreates it with its previous times", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	const [stored] = events(ctx.db);
	ctx.db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('source-3', 'owner', 'mailbox-a', 'inbound', 'alice@partner.test', 'support@example.com', 'Cancelled', 'received', 3)",
		)
		.run();
	ctx.db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES ('sugg-cancel', 'mailbox-a', 'source-3', 'owner', 'calendar_invite', 'open', 'Cancelled', ?, 3)",
		)
		.run(JSON.stringify(payload({ method: "CANCEL", existingEventId: stored.id, sequence: 1 })));
	const cancel = { id: "sugg-cancel", mailboxId: "mailbox-a", messageId: "source-3", status: "open" };
	await assert.rejects(acceptInvite(ctx.env, ctx.user, full, cancel, "accept"), (error) => error.status === 400);
	await acceptInvite(ctx.env, ctx.user, full, cancel, "remove");
	assert.equal(events(ctx.db).length, 0);
	const [removal] = actions(ctx.db, "action = 'delete_event'");
	await undoAgentAction(ctx.env, user, removal.id);
	const [back] = events(ctx.db);
	assert.equal(back.id, stored.id);
	assert.equal(back.starts_at, stored.starts_at);
	assert.equal(back.ends_at, stored.ends_at);
	assert.equal(back.ical_uid, stored.ical_uid);
	assert.equal(suggestion(ctx.db, "sugg-cancel").status, "open");
});

test("propose saves a draft with the stored slots appended and sends nothing", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	const result = await answer(ctx, "propose");
	assert.match(result.url, /^\/drafts\//);
	assert.equal(ctx.sent.length, 0);
	assert.equal(events(ctx.db).length, 0);
	const draft = ctx.db.db.prepare("SELECT * FROM messages WHERE status = 'draft'").get();
	assert.match(draft.to_addr, /alice@partner\.test/);
	assert.match(draft.text_body, /Wed, 13 Mar 2030, 10:00-11:00 \(UTC\)/);
	assert.match(draft.text_body, /Thu, 14 Mar 2030, 10:00-11:00 \(UTC\)/);
	assert.equal(suggestion(ctx.db).status, "open");
	const again = await answer(ctx, "propose");
	assert.equal(again.draftId, result.draftId);
	assert.equal(ctx.db.db.prepare("SELECT count(*) AS n FROM messages WHERE status = 'draft'").get().n, 1);
});

test("propose addresses the ICS organizer only, not the From or Reply-To of the mail", async (t) => {
	const ctx = await setup(t);
	ctx.db.db
		.prepare(
			"UPDATE messages SET from_addr = 'Calendar <notifications@service.test>', raw_r2_key = 'raw/source-1.eml' WHERE id = 'source-1'",
		)
		.run();
	await ctx.env.BUCKET.put(
		"raw/source-1.eml",
		new TextEncoder().encode(
			"From: Calendar <notifications@service.test>\r\nReply-To: Assistant <assistant@service.test>\r\nTo: support@example.com\r\nSubject: Planning\r\n\r\nJoin us",
		),
	);
	addSuggestion(ctx.db, "sugg-1", payload({ organizer: "boss@partner.test" }));
	await answer(ctx, "propose");
	const draft = ctx.db.db.prepare("SELECT * FROM messages WHERE status = 'draft'").get();
	assert.equal(draft.to_addr, "boss@partner.test");
	assert.ok(!draft.cc_addr);
});

test("propose on an invite without an organizer is a 409 that writes no draft or action", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload({ organizer: null, organizerMatchesSender: false }));
	await assert.rejects(answer(ctx, "propose"), (error) => error.status === 409);
	assert.equal(ctx.db.db.prepare("SELECT count(*) AS n FROM messages WHERE status = 'draft'").get().n, 0);
	assert.equal(actions(ctx.db).length, 0);
	assert.equal(suggestion(ctx.db).status, "open");
	assert.equal(ctx.sent.length, 0);
});

test("undo of an accepted invite by a full-access user who did not send the reply is a 403 that changes nothing", async (t) => {
	const ctx = await setup(t, { undoSendSeconds: 30 });
	ctx.db.db.exec(`
		UPDATE mailboxes SET type = 'shared' WHERE id = 'mailbox-a';
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('helper', 'helper@example.com', 'hash', 'Helper', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-h', 'mailbox-a', 'helper', 'full_access', 1);
	`);
	addSuggestion(ctx.db, "sugg-1", payload());
	await answer(ctx, "accept");
	const [created] = actions(ctx.db, "action = 'create_event'");
	const snapshot = () =>
		JSON.stringify([
			events(ctx.db),
			actions(ctx.db),
			outbound(ctx.db),
			ctx.db.db.prepare("SELECT * FROM outbound_jobs").all(),
			suggestion(ctx.db),
		]);
	const before = snapshot();
	await assert.rejects(
		undoAgentAction(ctx.env, { id: "helper", role: "user" }, created.id),
		(error) => error.status === 403,
	);
	assert.equal(snapshot(), before);
	assert.equal(events(ctx.db).length, 1);
	assert.equal(outbound(ctx.db)[0].status, "queued");
});

test("options that do not fit the invitation or the user are refused without side effects", async (t) => {
	const ctx = await setup(t);
	addSuggestion(ctx.db, "sugg-1", payload());
	await assert.rejects(answer(ctx, "remove"), (error) => error.status === 400);
	await assert.rejects(answer(ctx, "bogus"), (error) => error.status === 400);
	await assert.rejects(answer(ctx, "decline_instead"), (error) => error.status === 409);
	await assert.rejects(
		acceptInvite(ctx.env, ctx.user, { canManage: true, canSendOnBehalf: false }, row("open"), "accept"),
		(error) => error.status === 403,
	);
	assert.equal(events(ctx.db).length, 0);
	assert.equal(ctx.sent.length, 0);
	assert.equal(actions(ctx.db).length, 0);
});
