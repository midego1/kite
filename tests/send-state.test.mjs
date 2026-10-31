import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { and, asc, eq } from "drizzle-orm";
import { bundleModules, root } from "./support/modules-bundle.mjs";

// Messages waiting in the outbound queue (undo delay, scheduled) and failed sends are listed in Sent with their
// state; only their author can take them back, and nothing else may move them while they wait.
const app = await bundleModules("kite-send-state-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["getDb", "src/db/index.ts"],
	["messages, outboundJobs", "src/db/schema/index.ts"],
	[
		"SENT_FOLDER_STATUSES, SENT_FOLDER_STATUS_PARAM, STUCK_SENDING_AFTER_MS, getSendStateLabel, isMoveRefusedWhileSending, isSendPending, isSentFolderStatus, parseStatusFilter",
		"src/lib/messages/send-state-utils.ts",
	],
	["loadSendStates, statusFilterCondition", "src/lib/messages/send-state.ts"],
	["cancelQueuedSend", "src/lib/email/queued-send.ts"],
	["getSendBannerActions", "src/components/messages/send-state-utils.ts"],
	["buildMessageCounts, getMessageFolder", "src/app/api/messages/counts/utils.ts"],
	["mailboxScopeCondition", "src/lib/messages/mailbox-scope.ts"],
]);

const SECONDS = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);

async function setup(t) {
	const database = new app.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await app.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('author', 'author@example.com', 'hash', 'Author', 'admin', 1),
			('mate', 'mate@example.com', 'hash', 'Mate', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'author', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('shared', 'author', 'domain-1', 'desk', 'shared', 1);
	`);
	const env = { DB: database };
	return { database, env, db: app.getDb(env) };
}

let count = 0;
function insertOutbound(
	database,
	status,
	{ userId = "author", createdAt = SECONDS(), job, mailboxId = "shared" } = {},
) {
	const id = `out-${++count}`;
	database.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES (?, ?, ?, 'outbound', 'desk@example.com', 'x@example.org', ?, ?, 1, ?)",
		)
		.run(id, userId, mailboxId, `Subject ${id}`, status, createdAt);
	if (job) {
		database.db
			.prepare(
				"INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, error, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)",
			)
			.run(
				`job-${id}`,
				userId,
				id,
				job.status,
				job.error ?? null,
				job.scheduledAt ?? null,
				createdAt,
				job.updatedAt ?? createdAt,
			);
	}
	return id;
}

const statusOf = (database, id) => database.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status;
const jobStatusOf = (database, id) =>
	database.db.prepare("SELECT status FROM outbound_jobs WHERE message_id = ?").get(id).status;

test("the Sent folder lists sent, queued and failed messages, and a plain status filter stays exact", async (t) => {
	const { database, db } = await setup(t);
	const sent = insertOutbound(database, "sent");
	const queued = insertOutbound(database, "queued", { job: { status: "queued", scheduledAt: SECONDS(3_600_000) } });
	const failed = insertOutbound(database, "failed", { job: { status: "failed", error: "Provider refused" } });
	const draft = insertOutbound(database, "draft");
	database.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('in-1', 'author', 'shared', 'inbound', 'a@example.org', 'desk@example.com', 'Hello', 'received', 1)",
		)
		.run();

	assert.equal(app.SENT_FOLDER_STATUS_PARAM, "sent,queued,failed");
	const list = async (param) =>
		(
			await db
				.select({ id: app.messages.id })
				.from(app.messages)
				.where(and(eq(app.messages.direction, "outbound"), app.statusFilterCondition(app.parseStatusFilter(param))))
				.orderBy(asc(app.messages.id))
		).map((row) => row.id);
	assert.deepEqual(await list(app.SENT_FOLDER_STATUS_PARAM), [sent, queued, failed]);
	assert.deepEqual(await list("sent"), [sent]);
	assert.ok(!(await list(app.SENT_FOLDER_STATUS_PARAM)).includes(draft));
});

test("status filters split on commas, trim and ignore empty parts", () => {
	assert.deepEqual(app.parseStatusFilter("sent, queued,,failed"), ["sent", "queued", "failed"]);
	assert.equal(app.parseStatusFilter(""), null);
	assert.equal(app.parseStatusFilter(null), null);
	assert.deepEqual(app.parseStatusFilter("sent"), ["sent"]);
	assert.ok(app.isSentFolderStatus("queued") && app.isSentFolderStatus("failed") && !app.isSentFolderStatus("draft"));
});

test("queued and failed messages count toward Sent, drafts stay in Drafts", () => {
	const row = (status) => ({
		mailboxId: "m",
		folderId: null,
		direction: "outbound",
		status,
		read: true,
		starred: false,
		snoozedUntil: null,
		total: 1,
	});
	assert.equal(app.getMessageFolder(row("sent")), "sent");
	assert.equal(app.getMessageFolder(row("queued")), "sent");
	assert.equal(app.getMessageFolder(row("failed")), "sent");
	assert.equal(app.getMessageFolder(row("draft")), "drafts");
	const counts = app.buildMessageCounts([row("sent"), row("queued"), row("failed"), row("draft")]);
	assert.equal(counts.folders.sent.total, 3);
	assert.equal(counts.folders.drafts.total, 1);
});

test("send states come from the newest outbound job, and only the author is told why it failed", async (t) => {
	const { database, db } = await setup(t);
	const when = new Date(Date.now() + 3_600_000);
	when.setMilliseconds(0);
	const queued = insertOutbound(database, "queued", {
		job: { status: "queued", scheduledAt: Math.floor(when / 1000) },
	});
	const failed = insertOutbound(database, "failed", { job: { status: "failed", error: "Provider refused" } });
	const sent = insertOutbound(database, "sent", { job: { status: "sent" } });
	const rows = database.db.prepare("SELECT id, status, user_id AS userId FROM messages").all();

	const own = await app.loadSendStates(db, rows, "author");
	assert.deepEqual(own.get(queued), {
		status: "queued",
		scheduledAt: when.toISOString(),
		cancellable: true,
		inFlight: false,
		own: true,
	});
	assert.deepEqual(own.get(failed), {
		status: "failed",
		scheduledAt: null,
		cancellable: false,
		inFlight: false,
		own: true,
		error: "Provider refused",
	});
	assert.equal(own.has(sent), false);

	const teammate = await app.loadSendStates(db, rows, "mate");
	assert.deepEqual(teammate.get(queued), {
		status: "queued",
		scheduledAt: when.toISOString(),
		cancellable: true,
		inFlight: false,
		own: false,
	});
	assert.equal("error" in teammate.get(failed), false);
	assert.equal(teammate.get(failed).own, false);
});

test("Sending… is the undo hold, Scheduled · is a later time, Failed to send is a failure", () => {
	const now = Date.parse("2026-10-30T08:00:00Z");
	const created = "2026-10-30T08:00:00Z";
	const format = (value) => `at ${value}`;
	const hold = { status: "queued", scheduledAt: "2026-10-30T08:00:20Z", cancellable: true, inFlight: false, own: true };
	const later = {
		status: "queued",
		scheduledAt: "2026-10-30T09:00:00Z",
		cancellable: true,
		inFlight: false,
		own: true,
	};
	assert.deepEqual(app.getSendStateLabel(hold, created, format, now), { kind: "sending", text: "Sending…" });
	assert.deepEqual(app.getSendStateLabel(later, created, format, now), {
		kind: "scheduled",
		text: "Scheduled · at 2026-10-30T09:00:00Z",
	});
	// A scheduled time that has passed is on its way out.
	assert.equal(app.getSendStateLabel(later, created, format, now + 2 * 3_600_000).kind, "sending");
	assert.deepEqual(
		app.getSendStateLabel(
			{ status: "failed", scheduledAt: null, cancellable: false, inFlight: false, own: true },
			created,
			format,
			now,
		),
		{
			kind: "failed",
			text: "Failed to send",
		},
	);
});

test("only a queued message is pending; it cannot be moved while it waits", () => {
	assert.equal(app.isSendPending("queued"), true);
	for (const status of ["sent", "failed", "draft", "trash"]) assert.equal(app.isSendPending(status), false, status);
});

test("cancelling a queued send puts it back in the author's drafts and cancels its job", async (t) => {
	const { database, env } = await setup(t);
	const id = insertOutbound(database, "queued", { job: { status: "queued", scheduledAt: SECONDS(3_600_000) } });
	assert.deepEqual(await app.cancelQueuedSend(env, "mate", id), { ok: false, reason: "not_found" });
	assert.equal(statusOf(database, id), "queued");
	assert.deepEqual(await app.cancelQueuedSend(env, "author", id), { ok: true, draftId: id });
	assert.equal(statusOf(database, id), "draft");
	assert.equal(jobStatusOf(database, id), "cancelled");
	// Private again: drafts of other users are filtered out of every list.
	const visible = database.db
		.prepare("SELECT status FROM messages WHERE id = ? AND (status != 'draft' OR user_id = ?)")
		.get(id, "mate");
	assert.equal(visible, undefined);
});

test("a send that is already being delivered is too late to cancel, and a sent message is not found", async (t) => {
	const { database, env } = await setup(t);
	const claimed = insertOutbound(database, "queued", { job: { status: "sending" } });
	assert.deepEqual(await app.cancelQueuedSend(env, "author", claimed), { ok: false, reason: "too_late" });
	assert.equal(statusOf(database, claimed), "queued");
	const sent = insertOutbound(database, "sent", { job: { status: "sent" } });
	assert.deepEqual(await app.cancelQueuedSend(env, "author", sent), { ok: false, reason: "not_found" });
	assert.equal(statusOf(database, sent), "sent");
});

test("a failed send can be taken back to Drafts to edit and send again, by its author only", async (t) => {
	const { database, env } = await setup(t);
	const id = insertOutbound(database, "failed", { job: { status: "failed", error: "boom" } });
	assert.deepEqual(await app.cancelQueuedSend(env, "mate", id), { ok: false, reason: "not_found" });
	assert.deepEqual(await app.cancelQueuedSend(env, "author", id), { ok: true, draftId: id });
	assert.equal(statusOf(database, id), "draft");
});

test("the mailbox scope keeps queued sends visible to every reader and other users' drafts hidden", async (t) => {
	const { database, db } = await setup(t);
	const queued = insertOutbound(database, "queued", { job: { status: "queued", scheduledAt: SECONDS(3_600_000) } });
	const draft = insertOutbound(database, "draft");
	const ids = async (userId) =>
		(
			await db
				.select({ id: app.messages.id })
				.from(app.messages)
				.where(app.mailboxScopeCondition(["shared"], userId))
		).map((row) => row.id);
	assert.deepEqual(await ids("mate"), [queued]);
	assert.deepEqual((await ids("author")).sort(), [queued, draft].sort());
});

test("a claimed (in-flight) job is not cancellable and reads Sending…, even for a send scheduled for later", async (t) => {
	const { database, env, db } = await setup(t);
	const id = insertOutbound(database, "queued", { job: { status: "sending", scheduledAt: SECONDS(3_600_000) } });
	const rows = database.db.prepare("SELECT id, status, user_id AS userId FROM messages").all();
	const state = (await app.loadSendStates(db, rows, "author")).get(id);
	assert.equal(state.cancellable, false);
	assert.equal(state.inFlight, true);
	assert.equal(state.stuckMinutes, undefined);
	assert.equal(app.getSendStateLabel(state, new Date(), (value) => value).text, "Sending…");
	assert.deepEqual(await app.cancelQueuedSend(env, "author", id), { ok: false, reason: "too_late" });
	assert.equal(statusOf(database, id), "queued");
	assert.equal(jobStatusOf(database, id), "sending");
});

test("a send claimed for longer than the timeout is stuck, and only then can its author move it to Drafts", async (t) => {
	const { database, env, db } = await setup(t);
	const stuckFor = 25 * 60_000;
	const id = insertOutbound(database, "queued", {
		job: { status: "sending", updatedAt: SECONDS(-stuckFor) },
	});
	const justUnder = insertOutbound(database, "queued", {
		job: { status: "sending", updatedAt: SECONDS(-(app.STUCK_SENDING_AFTER_MS - 60_000)) },
	});
	const rows = database.db.prepare("SELECT id, status, user_id AS userId FROM messages").all();
	const states = await app.loadSendStates(db, rows, "author");
	assert.equal(states.get(id).stuckMinutes, 25);
	assert.equal(states.get(id).cancellable, false);
	assert.equal(states.get(justUnder).stuckMinutes, undefined);
	assert.deepEqual(
		app.getSendStateLabel(states.get(id), new Date(), (value) => value),
		{
			kind: "stuck",
			text: "Stuck: still sending after 25 minutes",
		},
	);

	assert.deepEqual(await app.cancelQueuedSend(env, "author", justUnder), { ok: false, reason: "too_late" });
	assert.deepEqual(await app.cancelQueuedSend(env, "mate", id), { ok: false, reason: "not_found" });
	assert.deepEqual(await app.cancelQueuedSend(env, "author", id), { ok: true, draftId: id });
	assert.equal(statusOf(database, id), "draft");
	assert.equal(jobStatusOf(database, id), "failed");
});

test("cancelling flips the job and the message together: a failure on the message leaves the job queued", async (t) => {
	const { database, env } = await setup(t);
	const id = insertOutbound(database, "queued", { job: { status: "queued", scheduledAt: SECONDS(3_600_000) } });
	database.db.exec(`
		CREATE TRIGGER fail_draft BEFORE UPDATE OF status ON messages WHEN NEW.status = 'draft'
		BEGIN SELECT RAISE(ABORT, 'disk full'); END;
	`);
	await assert.rejects(app.cancelQueuedSend(env, "author", id), /disk full/);
	assert.equal(statusOf(database, id), "queued");
	assert.equal(jobStatusOf(database, id), "queued");
	database.db.exec("DROP TRIGGER fail_draft");
	assert.deepEqual(await app.cancelQueuedSend(env, "author", id), { ok: true, draftId: id });
	assert.equal(jobStatusOf(database, id), "cancelled");
});

test("the author needs current send or manage access to the mailbox to cancel", async (t) => {
	const { database, env } = await setup(t);
	database.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('theirs', 'mate', 'domain-1', 'theirs', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant-1', 'theirs', 'author', 'send_as', 1);
	`);
	const queue = () =>
		insertOutbound(database, "queued", {
			mailboxId: "theirs",
			job: { status: "queued", scheduledAt: SECONDS(3_600_000) },
		});
	const withAccess = queue();
	assert.deepEqual(await app.cancelQueuedSend(env, "author", withAccess), { ok: true, draftId: withAccess });

	// Access removed after the send was queued: the author can no longer take it back.
	const revoked = queue();
	database.db.exec("DELETE FROM mailbox_access WHERE id = 'grant-1'");
	assert.deepEqual(await app.cancelQueuedSend(env, "author", revoked), { ok: false, reason: "not_found" });
	assert.equal(statusOf(database, revoked), "queued");
	assert.equal(jobStatusOf(database, revoked), "queued");

	// Read-only is not enough to act for the mailbox.
	database.db.exec(
		"INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant-2', 'theirs', 'author', 'read_only', 1)",
	);
	assert.deepEqual(await app.cancelQueuedSend(env, "author", revoked), { ok: false, reason: "not_found" });
});

test("moving actions are refused on a queued message, reading actions are not", () => {
	for (const action of ["archive", "trash", "spam", "phishing", "delete", "inbox", "folder", "restore"]) {
		assert.equal(app.isMoveRefusedWhileSending(action, "queued"), true, action);
		assert.equal(app.isMoveRefusedWhileSending(action, "sent"), false, action);
	}
	assert.equal(app.isMoveRefusedWhileSending("read", "queued"), false);
	assert.equal(app.isMoveRefusedWhileSending("unread", "queued"), false);
	// A failed send is an ordinary message that may be filed or trashed.
	assert.equal(app.isMoveRefusedWhileSending("trash", "failed"), false);
});

test("the reader banner offers Cancel send only while the job is unclaimed, and only to the author", () => {
	const base = { status: "queued", scheduledAt: null, cancellable: true, inFlight: false, own: true };
	assert.equal(app.getSendBannerActions(base), "cancel");
	assert.equal(app.getSendBannerActions({ ...base, own: false }), null);
	// In flight: no Cancel, no Edit, just the Sending… label.
	assert.equal(app.getSendBannerActions({ ...base, cancellable: false, inFlight: true }), null);
	// Stalled: only the way out.
	assert.equal(app.getSendBannerActions({ ...base, cancellable: false, inFlight: true, stuckMinutes: 12 }), "stuck");
	assert.equal(app.getSendBannerActions({ ...base, status: "failed", cancellable: false }), "failed");
	assert.equal(app.getSendBannerActions({ ...base, status: "failed", cancellable: false, own: false }), null);
});

test("the undo hold is judged by the longest undo window a user can pick", () => {
	const created = "2026-10-30T08:00:00Z";
	const now = Date.parse(created);
	const at = (seconds) => ({
		status: "queued",
		scheduledAt: new Date(now + seconds * 1000).toISOString(),
		cancellable: true,
		inFlight: false,
		own: true,
	});
	const kind = (state) => app.getSendStateLabel(state, created, (value) => value, now).kind;
	assert.equal(kind(at(30)), "sending");
	assert.equal(kind(at(90)), "scheduled");
});
