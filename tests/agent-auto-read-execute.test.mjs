import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-execute-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		execute: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/execute.ts")),
		effects: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/action-effects.ts")),
		activity: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/activity.ts")),
		pruning: fileURLToPath(import.meta.resolve("../src/lib/maintenance/pruning.ts")),
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
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { executeAction, undoAgentAction, recordBlockedAction } = await load("execute");
const { dismissSuggestionEffect, draftReplyEffect } = await load("effects");
const { listAgentActivity } = await load("activity");
const { runDatabasePruning } = await load("pruning");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY = 24 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const owner = { id: "owner", role: "user" };
const manager = { id: "manager", role: "user" };
const reader = { id: "reader", role: "user" };
const onBehalf = { id: "helper", role: "user" };
const stranger = { id: "stranger", role: "user" };
const fullAccess = { canManage: true, canSendOnBehalf: true };

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('manager', 'manager@example.com', 'hash', 'Manager', 1),
			('reader', 'reader@example.com', 'hash', 'Reader', 1),
			('helper', 'helper@example.com', 'hash', 'Helper', 1),
			('stranger', 'stranger@example.com', 'hash', 'Stranger', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('access-1', 'mailbox-a', 'manager', 'full_access', 1),
			('access-2', 'mailbox-a', 'reader', 'read_only', 1),
			('access-3', 'mailbox-a', 'helper', 'send_on_behalf', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('source-1', 'owner', 'mailbox-a', 'inbound', '<source-1@sender.test>', 'Sam <sam@sender.test>', 'support@example.com', 'Figures', 'Could you send the figures?', 'received', 1);
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, created_at)
			VALUES ('sugg-1', 'mailbox-a', 'source-1', 'owner', 'reply', 'open', 'Reply to Sam', 1);
	`);
	const deleted = [];
	const env = { DB: db, BUCKET: { delete: async (key) => void deleted.push(key) } };
	return { db, env, deleted };
}

const rows = (db, where = "1 = 1") => db.db.prepare(`SELECT * FROM agent_actions WHERE ${where} ORDER BY rowid`).all();
const suggestionStatus = (db) => db.db.prepare("SELECT status FROM agent_suggestions WHERE id = 'sugg-1'").get().status;
const draftCount = (db) => db.db.prepare("SELECT count(*) AS n FROM messages WHERE status = 'draft'").get().n;

async function dismiss(env, user = owner, extra = {}) {
	return executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "dismiss",
		initiator: "user",
		actingUserId: user.id,
		permissions: fullAccess,
		effect: await dismissSuggestionEffect(env, "sugg-1", user.id),
		...extra,
	});
}

function insertAction(db, values) {
	const row = {
		id: "act-1",
		mailbox_id: "mailbox-a",
		suggestion_id: "sugg-1",
		message_id: "source-1",
		initiator: "user",
		acting_user_id: "owner",
		action: "dismiss",
		variant: "",
		status: "applied",
		before: null,
		after: null,
		undo_until: nowSeconds() + DAY,
		created_at: nowSeconds(),
		updated_at: nowSeconds(),
		...values,
	};
	const columns = Object.keys(row);
	db.db
		.prepare(`INSERT INTO agent_actions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.run(...Object.values(row));
	return row.id;
}

const reviewer = {
	id: "owner",
	email: "owner@example.com",
	name: "Owner",
	role: "user",
	isPrimaryAdmin: false,
	disabled: false,
	timeZone: null,
};

function draftInput(env, effect, extra = {}) {
	return {
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "create_draft",
		initiator: "agent",
		actingUserId: "owner",
		autonomy: "suggest",
		gate: {
			level: "suggest",
			facts: { senderAddress: "sam@sender.test", phishingSignals: [], suspicious: false, authFailed: false },
			senderPolicy: null,
			context: { capabilities: { reply: true, calendar: true }, fullAutoAllowed: false },
		},
		effect,
		...extra,
	};
}

test("the pending row is written before the side effect and becomes applied with a 7-day undo window", async (t) => {
	const { db, env } = await setup(t);
	let seenDuringEffect = null;
	const result = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		action: "dismiss",
		initiator: "user",
		actingUserId: "owner",
		permissions: fullAccess,
		effect: {
			before: { status: "open" },
			ids: { token: "pre-generated" },
			async apply(ids) {
				seenDuringEffect = rows(db);
				assert.equal(ids.token, "pre-generated");
				return { status: "dismissed" };
			},
		},
	});
	assert.equal(result.status, "applied");
	assert.equal(seenDuringEffect.length, 1);
	assert.equal(seenDuringEffect[0].status, "pending");
	assert.equal(JSON.parse(seenDuringEffect[0].after).token, "pre-generated");
	assert.equal(JSON.parse(seenDuringEffect[0].before).status, "open");
	const [row] = rows(db);
	assert.equal(row.status, "applied");
	assert.deepEqual(JSON.parse(row.after), { token: "pre-generated", status: "dismissed" });
	assert.equal(row.reason, "user_click");
	const window = row.undo_until - row.created_at;
	assert.ok(window >= 7 * DAY - 2 && window <= 7 * DAY + 2, `undo window ${window}`);
});

test("executing the same action and variant twice applies once and skips the second call", async (t) => {
	const { db, env } = await setup(t);
	assert.equal((await dismiss(env)).status, "applied");
	let applied = 0;
	const second = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		action: "dismiss",
		initiator: "user",
		actingUserId: "owner",
		permissions: fullAccess,
		effect: { apply: async () => void applied++ },
	});
	assert.equal(second.status, "skipped");
	assert.equal(applied, 0);
	assert.equal(rows(db).length, 1);
});

test("a fresh pending row refuses a user click with a 409 conflict", async (t) => {
	const { db, env } = await setup(t);
	insertAction(db, { status: "pending", undo_until: null, updated_at: nowSeconds() - 60 });
	let applied = 0;
	await assert.rejects(
		dismiss(env, owner, { effect: { apply: async () => void applied++ } }),
		(error) => error.name === "AgentActionError" && error.status === 409,
	);
	assert.equal(applied, 0);
	assert.equal(suggestionStatus(db), "open");
	assert.equal(rows(db).length, 1);
});

test("a stale pending row whose draft already exists is taken over without a second draft", async (t) => {
	const { db, env } = await setup(t);
	insertAction(db, {
		action: "create_draft",
		initiator: "agent",
		status: "pending",
		after: JSON.stringify({ draftId: "msg_existing" }),
		undo_until: null,
		updated_at: nowSeconds() - 11 * 60,
	});
	db.db.exec(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('msg_existing', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'sam@sender.test', 'Re: Figures', 'draft', 1)",
	);
	const effect = draftReplyEffect({
		env,
		reviewer,
		mailboxId: "mailbox-a",
		sourceMessageId: "source-1",
		body: "Here are the figures.",
	});
	const result = await executeAction(draftInput(env, effect));
	assert.equal(result.status, "applied");
	assert.equal(result.actionId, "act-1");
	assert.equal(result.after.draftId, "msg_existing");
	assert.equal(draftCount(db), 1);
	assert.equal(rows(db).length, 1);
	assert.equal(rows(db)[0].status, "applied");
});

test("a stale pending row whose draft never happened applies it exactly once under the stored id", async (t) => {
	const { db, env } = await setup(t);
	insertAction(db, {
		action: "create_draft",
		initiator: "agent",
		status: "pending",
		after: JSON.stringify({ draftId: "msg_planned" }),
		undo_until: null,
		updated_at: nowSeconds() - 11 * 60,
	});
	const effect = draftReplyEffect({
		env,
		reviewer,
		mailboxId: "mailbox-a",
		sourceMessageId: "source-1",
		body: "Here are the figures.",
	});
	const result = await executeAction(draftInput(env, effect));
	assert.equal(result.status, "applied");
	assert.equal(result.after.draftId, "msg_planned");
	assert.equal(draftCount(db), 1);
	assert.equal(
		db.db.prepare("SELECT to_addr FROM messages WHERE id = 'msg_planned'").get().to_addr.includes("sam@sender.test"),
		true,
	);
	const again = await executeAction(draftInput(env, effect));
	assert.equal(again.status, "skipped");
	assert.equal(draftCount(db), 1);
});

test("a fresh agent draft action pre-generates the draft id and records the policy rule", async (t) => {
	const { db, env } = await setup(t);
	const effect = draftReplyEffect({
		env,
		reviewer,
		mailboxId: "mailbox-a",
		sourceMessageId: "source-1",
		body: "Sure.",
	});
	const result = await executeAction(draftInput(env, effect));
	assert.equal(result.status, "applied");
	assert.equal(result.after.draftId, effect.ids.draftId);
	assert.equal(rows(db)[0].reason, "suggest_allows_create_draft");
	assert.equal(rows(db)[0].initiator, "agent");
});

test("policy refusals write a blocked row and run nothing", async (t) => {
	const { db, env } = await setup(t);
	let applied = 0;
	const effect = { apply: async () => void applied++ };
	const blockedAgent = await executeAction({ ...draftInput(env, effect), action: "dismiss" });
	assert.equal(blockedAgent.status, "blocked");
	assert.equal(blockedAgent.reason, "suggest_disallows_dismiss");
	const blockedUser = await dismiss(env, reader, {
		permissions: { canManage: false, canSendOnBehalf: false },
		effect,
	});
	assert.equal(blockedUser.reason, "missing_manage");
	const offAgent = await executeAction({
		...draftInput(env, effect),
		gate: { ...draftInput(env, effect).gate, level: "off" },
	});
	assert.equal(offAgent.reason, "autonomy_off");
	const guard = await recordBlockedAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: null,
		messageId: "source-1",
		action: "create_draft",
		initiator: "agent",
		actingUserId: "owner",
		reason: "draft_guard",
	});
	assert.ok(guard);
	assert.equal(applied, 0);
	assert.deepEqual(
		rows(db).map((row) => [row.status, row.reason]),
		[
			["blocked", "suggest_disallows_dismiss"],
			["blocked", "missing_manage"],
			["blocked", "autonomy_off"],
			["blocked", "draft_guard"],
		],
	);
});

test("a failing side effect marks the row failed with its reason and frees the outcome", async (t) => {
	const { db, env } = await setup(t);
	const result = await dismiss(env, owner, {
		effect: {
			apply: async () => {
				throw new Error("D1 is unavailable");
			},
		},
	});
	assert.equal(result.status, "failed");
	assert.equal(rows(db)[0].status, "failed");
	assert.equal(rows(db)[0].reason, "D1 is unavailable");
	assert.equal((await dismiss(env)).status, "applied");
});

test("undo of a dismiss reopens the suggestion once; a second undo is a 409 that writes nothing", async (t) => {
	const { db, env } = await setup(t);
	const { actionId } = await dismiss(env, manager);
	assert.equal(suggestionStatus(db), "dismissed");
	const undone = await undoAgentAction(env, manager, actionId);
	assert.equal(suggestionStatus(db), "open");
	const original = db.db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(actionId);
	assert.equal(original.status, "undone");
	assert.equal(original.undone_by_user_id, "manager");
	assert.ok(original.undone_at);
	const inverse = db.db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(undone.inverseActionId);
	assert.equal(inverse.initiator, "user");
	assert.equal(inverse.acting_user_id, "manager");
	assert.equal(inverse.variant, `undo:${actionId}`);
	assert.equal(inverse.undo_until, null);
	const before = rows(db).length;
	await assert.rejects(undoAgentAction(env, manager, actionId), (error) => error.status === 409);
	await assert.rejects(undoAgentAction(env, manager, undone.inverseActionId), (error) => error.status === 409);
	assert.equal(rows(db).length, before);
	assert.equal(suggestionStatus(db), "open");
	// The outcome can run again once its earlier row was undone.
	assert.equal((await dismiss(env)).status, "applied");
});

test("undo is refused after undo_until and for failed or blocked rows", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE agent_suggestions SET status = 'dismissed'");
	insertAction(db, { id: "expired", undo_until: nowSeconds() - 1, before: JSON.stringify({ status: "open" }) });
	insertAction(db, { id: "failed", status: "failed", variant: "x" });
	insertAction(db, { id: "blocked", status: "blocked", variant: "y" });
	for (const id of ["expired", "failed", "blocked"])
		await assert.rejects(undoAgentAction(env, owner, id), (error) => error.status === 409, id);
	assert.equal(db.db.prepare("SELECT status FROM agent_actions WHERE id = 'expired'").get().status, "applied");
	assert.equal(suggestionStatus(db), "dismissed");
	assert.equal(rows(db).length, 3);
});

test("undo is 404 without full access and 403 for a full-access user lacking the needed permission", async (t) => {
	const { db, env } = await setup(t);
	const { actionId } = await dismiss(env);
	for (const user of [reader, onBehalf, stranger])
		await assert.rejects(undoAgentAction(env, user, actionId), (error) => error.status === 404, user.id);
	await assert.rejects(undoAgentAction(env, owner, "missing"), (error) => error.status === 404);
	insertAction(db, {
		id: "draft-action",
		action: "create_draft",
		initiator: "agent",
		after: JSON.stringify({ draftId: "msg_x" }),
	});
	// Drafts belong to the reviewer; another full-access user may not discard them.
	await assert.rejects(undoAgentAction(env, manager, "draft-action"), (error) => error.status === 403);
	assert.equal(suggestionStatus(db), "dismissed");
	assert.deepEqual(
		rows(db).map((row) => row.status),
		["applied", "applied"],
	);
});

test("undo of create_draft discards an unedited draft but never a sent or edited one", async (t) => {
	const { db, env, deleted } = await setup(t);
	const effect = draftReplyEffect({
		env,
		reviewer,
		mailboxId: "mailbox-a",
		sourceMessageId: "source-1",
		body: "Sure.",
	});
	const { actionId, after } = await executeAction(draftInput(env, effect));
	db.db.prepare("UPDATE messages SET status = 'sent' WHERE id = ?").run(after.draftId);
	await assert.rejects(
		undoAgentAction(env, owner, actionId),
		(error) => error.status === 409 && /sent/.test(error.message),
	);
	assert.equal(db.db.prepare("SELECT status FROM messages WHERE id = ?").get(after.draftId).status, "sent");
	assert.equal(db.db.prepare("SELECT status FROM agent_actions WHERE id = ?").get(actionId).status, "applied");

	db.db.prepare("UPDATE messages SET status = 'draft' WHERE id = ?").run(after.draftId);
	db.db
		.prepare("UPDATE agent_draft_metadata SET human_edited_at = ? WHERE draft_id = ?")
		.run(nowSeconds(), after.draftId);
	await assert.rejects(
		undoAgentAction(env, owner, actionId),
		(error) => error.status === 409 && /edited/.test(error.message),
	);
	assert.equal(draftCount(db), 1);

	db.db.prepare("UPDATE agent_draft_metadata SET human_edited_at = NULL WHERE draft_id = ?").run(after.draftId);
	await undoAgentAction(env, owner, actionId);
	assert.equal(draftCount(db), 0);
	assert.deepEqual(deleted, []);
	assert.equal(db.db.prepare("SELECT status FROM agent_actions WHERE id = ?").get(actionId).status, "undone");
});

test("activity lists actions newest first, including blocked and failed, and recent skipped triage jobs", async (t) => {
	const { db, env } = await setup(t);
	insertAction(db, { id: "old", status: "failed", reason: "boom", created_at: nowSeconds() - 100 });
	insertAction(db, { id: "new", status: "blocked", reason: "draft_guard", action: "create_draft" });
	insertAction(db, { id: "live", created_at: nowSeconds() - 50 });
	db.db.exec(`
		INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, reason, next_attempt_at, created_at)
			VALUES ('job-skip', 'mailbox-a', 'source-1', 'owner', 'triage', 'skipped', 'daily_limit', 0, ${nowSeconds()});
		INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, reason, next_attempt_at, created_at)
			VALUES ('job-draft', 'mailbox-a', 'source-1', 'owner', 'draft', 'skipped', 'disabled', 0, ${nowSeconds()});
	`);
	const activity = await listAgentActivity(env, "mailbox-a", "owner");
	assert.deepEqual(
		activity.actions.map((action) => [action.id, action.status, action.canUndo]),
		[
			["new", "blocked", false],
			["live", "applied", true],
			["old", "failed", false],
		],
	);
	assert.deepEqual(
		activity.actions.map((action) => action.subject),
		["Figures", "Figures", "Figures"],
	);
	assert.deepEqual(
		activity.skippedJobs.map((job) => [job.id, job.reason, job.subject]),
		[["job-skip", "daily_limit", "Figures"]],
	);
});

test("activity marks a draft available only to its owner while it is still a draft", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
			('draft-live', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'sam@sender.test', 'Re: Figures', 'draft', 2),
			('draft-sent', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'sam@sender.test', 'Re: Figures', 'trash', 2);
	`);
	const draftAction = (id, draftId, created) =>
		insertAction(db, {
			id,
			suggestion_id: null,
			action: "create_draft",
			initiator: "agent",
			after: JSON.stringify({ draftId }),
			created_at: created,
		});
	draftAction("live", "draft-live", nowSeconds() - 3);
	draftAction("gone", "draft-deleted", nowSeconds() - 2);
	draftAction("trashed", "draft-sent", nowSeconds() - 1);
	insertAction(db, { id: "plain", created_at: nowSeconds() });
	const available = async (viewer) =>
		(await listAgentActivity(env, "mailbox-a", viewer)).actions.map((action) => [action.id, action.draftAvailable]);
	assert.deepEqual(await available("owner"), [
		["plain", false],
		["trashed", false],
		["gone", false],
		["live", true],
	]);
	assert.deepEqual(await available("manager"), [
		["plain", false],
		["trashed", false],
		["gone", false],
		["live", false],
	]);
});

test("pruning removes agent_actions older than 180 days and keeps younger ones", async (t) => {
	const { db, env } = await setup(t);
	const now = new Date();
	const seconds = Math.floor(now.getTime() / 1000);
	insertAction(db, { id: "old", status: "undone", created_at: seconds - 181 * DAY });
	insertAction(db, { id: "young", status: "failed", created_at: seconds - 179 * DAY });
	const result = await runDatabasePruning(env, now);
	assert.equal(result.agent_actions, 1);
	assert.deepEqual(
		rows(db).map((row) => row.id),
		["young"],
	);
});

const insertEvent = (db, id, title, userId = "owner") =>
	db.db
		.prepare(
			"INSERT INTO calendar_events (id, user_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, '', '', '[]', 1791806400, 1791810000, 1, 1)",
		)
		.run(id, userId, title);

function insertCalendarActions(db) {
	insertEvent(db, "evt-1", "Quarterly offsite");
	insertAction(db, {
		id: "made",
		action: "create_event",
		after: JSON.stringify({ eventId: "evt-1" }),
		created_at: nowSeconds() - 3,
	});
	insertAction(db, {
		id: "removed",
		action: "delete_event",
		after: JSON.stringify({ eventId: "evt-gone" }),
		created_at: nowSeconds() - 2,
	});
	insertAction(db, { id: "reply", action: "send_rsvp", variant: "accepted", created_at: nowSeconds() - 1 });
}

const targetsOf = async (env, viewer) =>
	Object.fromEntries(
		(await listAgentActivity(env, "mailbox-a", viewer)).actions.map((action) => [action.id, action.target ?? null]),
	);

test("activity links calendar actions to their event while Calendar is on and falls back to the invitation for an RSVP", async (t) => {
	const { db, env } = await setup(t);
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	insertCalendarActions(db);
	assert.deepEqual(await targetsOf(env, "owner"), {
		reply: null,
		removed: { href: null, label: "Calendar event" },
		made: { href: "/calendar?date=2026-10-12&event=evt-1", label: "Quarterly offsite" },
	});
});

test("activity shows calendar actions as plain neutral text, with no event title, while Calendar is off", async (t) => {
	const { db, env } = await setup(t);
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	insertCalendarActions(db);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	const neutral = { href: null, label: "Calendar event" };
	assert.deepEqual(await targetsOf(env, "owner"), { reply: neutral, removed: neutral, made: neutral });
	const activity = await listAgentActivity(env, "mailbox-a", "owner");
	assert.doesNotMatch(JSON.stringify(activity), /Quarterly offsite/);
	assert.deepEqual(
		activity.actions.map((action) => action.subject),
		[null, null, null],
	);
});

test("activity never shows another user's event title to a manager of the shared mailbox", async (t) => {
	const { db, env } = await setup(t);
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	insertCalendarActions(db);
	const activity = await listAgentActivity(env, "mailbox-a", "manager");
	assert.deepEqual(activity.actions.find((action) => action.id === "made").target, {
		href: null,
		label: "Calendar event",
	});
	assert.doesNotMatch(JSON.stringify(activity), /Quarterly offsite/);
});
