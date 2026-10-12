import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-calendar-module-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the module state cache across the entries, so a toggle is seen everywhere.
await build({
	entryPoints: {
		steps: join(root, "src/lib/agent/auto-read/module-steps.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		api: join(root, "src/lib/agent/auto-read/suggestion-api.ts"),
		badges: join(root, "src/lib/agent/auto-read/message-suggestions.ts"),
		activity: join(root, "src/lib/agent/auto-read/activity.ts"),
		invoke: join(root, "src/lib/modules/invoke.ts"),
		context: join(root, "src/lib/modules/capability-utils.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		database: join(root, "src/db/index.ts"),
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
const { runModuleTriageSteps } = await load("steps");
const { executeAction, undoAgentAction } = await load("execute");
const { acceptSuggestion, listSuggestions } = await load("api");
const { loadRowSuggestions } = await load("badges");
const { listAgentActivity } = await load("activity");
const { invokeCapability } = await load("invoke");
const { buildCallContext } = await load("context");
const { clearModuleStateCache } = await load("state");
const { getDb } = await load("database");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const START = Date.parse("2030-03-12T10:00:00.000Z");
const ZONE = "America/New_York";
const owner = {
	id: "owner",
	role: "user",
	isPrimaryAdmin: false,
	timeZone: "UTC",
	undoSendSeconds: 0,
	email: "owner@example.com",
	disabled: false,
};
const viewer = { userId: "owner", role: "user", isPrimaryAdmin: false };

function ics(uid = "uid-step@partner.test") {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"METHOD:REQUEST",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20300101T000000Z",
		"DTSTART:20300312T100000Z",
		"DTEND:20300312T110000Z",
		"SUMMARY:Planning",
		"ORGANIZER:mailto:alice@partner.test",
		"SEQUENCE:0",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

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
		proposals: [],
		organizerMatchesSender: true,
		authPassed: true,
		existingEventId: null,
		...extra,
	};
}

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', '${ZONE}', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('source-1', 'owner', 'mailbox-a', 'inbound', '<source-1@partner.test>', 'Alice <alice@partner.test>', 'support@example.com', 'Planning', 'Join us', 'received', 1);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
			VALUES ('att-1', 'source-1', 'invite.ics', 'text/calendar', ${ics().length}, 'raw/att-1', 1);
		CREATE TABLE probe (pending INTEGER);
		CREATE TRIGGER probe_event BEFORE INSERT ON calendar_events BEGIN
			INSERT INTO probe SELECT count(*) FROM agent_actions WHERE status = 'pending' AND action = 'create_event';
		END;
	`);
	const objects = new Map([["raw/att-1", new TextEncoder().encode(ics())]]);
	const sent = [];
	const env = {
		DB: db,
		BUCKET: {
			put: async (key, value) => void objects.set(key, value),
			get: async (key) =>
				objects.has(key)
					? { size: objects.get(key).byteLength, arrayBuffer: async () => objects.get(key).buffer }
					: null,
			delete: async (key) => void objects.delete(key),
		},
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: `<sent-${sent.length}@cf.test>` };
			},
		},
		OUTBOUND_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		clearModuleStateCache();
	});
	return { db, env, sent };
}

function toggle(db, moduleId, enabled) {
	db.db.prepare("UPDATE module_settings SET enabled = ? WHERE module_id = ?").run(enabled ? 1 : 0, moduleId);
	clearModuleStateCache();
}

const stepInput = (env) => ({
	env,
	job: { mailboxId: "mailbox-a" },
	reviewer: { ...viewer, timeZone: ZONE },
	source: { id: "source-1", fromAddr: "Alice <alice@partner.test>", subject: "Planning", createdAt: new Date() },
	facts: {
		authPassed: true,
		bulk: false,
		knownContact: true,
		phishingSignals: [],
		senderAddress: "alice@partner.test",
		inviteAttachments: [{ filename: "invite.ics", contentType: "text/calendar", size: 10 }],
	},
	capabilities: { calendar: true },
	model: null,
});

const addSuggestion = (db, id = "sugg-1", status = "open", body = payload()) =>
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES (?, 'mailbox-a', 'source-1', 'owner', 'calendar_invite', ?, 'Invitation', ?, 1)",
		)
		.run(id, status, JSON.stringify(body));
const events = (db) => db.db.prepare("SELECT * FROM calendar_events ORDER BY created_at").all();
const actions = (db, where = "1 = 1") =>
	db.db.prepare(`SELECT * FROM agent_actions WHERE ${where} ORDER BY rowid`).all();

/** Weekday and minutes since midnight of an instant in a zone. */
function localTime(iso, timeZone) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			hour: "numeric",
			minute: "numeric",
			hourCycle: "h23",
		})
			.formatToParts(new Date(iso))
			.map((part) => [part.type, part.value]),
	);
	return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function conflictingEvent(db) {
	db.db.exec(`
		INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at)
		VALUES ('busy-1', 'owner', 'Busy', ${(START - 1_800_000) / 1000}, ${(START + 1_800_000) / 1000}, 1, 1);
	`);
}

test("the calendar step reads the invitation through the module and returns one calendar_invite suggestion", async (t) => {
	const { env } = await setup(t);
	const run = await runModuleTriageSteps(stepInput(env));
	assert.deepEqual(run.skipped, []);
	assert.equal(run.planned.length, 1);
	assert.equal(run.planned[0].kind, "calendar_invite");
	assert.equal(run.planned[0].payload.uid, "uid-step@partner.test");
	assert.equal(run.planned[0].autoExecute, false);
});

test("the invitation is read through the host facade, not core attachment tables or R2", async (t) => {
	const source = readFileSync(join(root, "src/lib/agent/auto-read/invite.ts"), "utf8");
	assert.doesNotMatch(source, /messageAttachments|BUCKET/);
	assert.match(source, /moduleHost\.mail\.readAttachment/);
	const { env } = await setup(t);
	let reads = 0;
	const bucket = env.BUCKET.get;
	env.BUCKET.get = async (...args) => {
		reads += 1;
		return bucket(...args);
	};
	assert.equal((await runModuleTriageSteps(stepInput(env))).planned.length, 1);
	assert.equal(reads, 1, "one read, made by the host");
});

test("an unreadable invitation (a reviewer without access) or one over the size cap yields no suggestion", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES ('stranger', 'stranger@example.com', 'hash', 'Stranger', 'UTC', 1)",
	);
	const input = stepInput(env);
	const stranger = { userId: "stranger", role: "user", isPrimaryAdmin: false, timeZone: "UTC" };
	assert.deepEqual((await runModuleTriageSteps({ ...input, reviewer: stranger })).planned, []);

	db.db.prepare("UPDATE message_attachments SET size = 300000 WHERE id = 'att-1'").run();
	assert.deepEqual((await runModuleTriageSteps(input)).planned, []);
	db.db.prepare("UPDATE message_attachments SET size = ? WHERE id = 'att-1'").run(ics().length);
	assert.equal((await runModuleTriageSteps(input)).planned.length, 1);
});

test("with Calendar off the step is skipped with the module id and never reads the invitation", async (t) => {
	const { db, env } = await setup(t);
	toggle(db, "calendar", false);
	const run = await runModuleTriageSteps(stepInput(env));
	assert.deepEqual(run, { planned: [], skipped: ["calendar"] });
	toggle(db, "calendar", true);
	assert.equal((await runModuleTriageSteps(stepInput(env))).planned.length, 1);
});

test("a message without an invitation attachment runs no calendar step and records no skip, even with Calendar off", async (t) => {
	const { db, env } = await setup(t);
	toggle(db, "calendar", false);
	const input = stepInput(env);
	const run = await runModuleTriageSteps({ ...input, facts: { ...input.facts, inviteAttachments: [] } });
	assert.deepEqual(run, { planned: [], skipped: [] });
});

test("proposed slots follow Booking's working hours when Booking is on and have event types", async (t) => {
	const { db, env } = await setup(t);
	conflictingEvent(db);
	db.db.exec(`
		INSERT INTO booking_events (id, user_id, name, slug, duration_minutes, weekdays, time_ranges, start_time, end_time, time_zone, enabled, created_at, updated_at)
		VALUES ('type-1', 'owner', 'Intro', 'intro', 30, '[0,1,2,3,4,5,6]', '[{"startTime":"10:00","endTime":"12:00"}]', '10:00', '12:00', '${ZONE}', 1, 1, 1);
	`);
	const { planned } = await runModuleTriageSteps(stepInput(env));
	const slots = planned[0].payload.proposals;
	assert.ok(slots.length > 0, "slots were proposed");
	for (const slot of slots) {
		const start = localTime(slot.start, ZONE);
		const end = localTime(slot.end, ZONE);
		assert.ok(start.minutes >= 600 && end.minutes <= 720, `${slot.start} is outside 10:00-12:00 ${ZONE}`);
	}
});

test("with Booking off the slots fall Monday to Friday 09:00-17:00 in the reviewer's zone and the step still succeeds", async (t) => {
	const { db, env } = await setup(t);
	conflictingEvent(db);
	db.db.exec(`
		INSERT INTO booking_events (id, user_id, name, slug, duration_minutes, weekdays, time_ranges, start_time, end_time, time_zone, enabled, created_at, updated_at)
		VALUES ('type-1', 'owner', 'Intro', 'intro', 30, '[6]', '[{"startTime":"10:00","endTime":"12:00"}]', '10:00', '12:00', 'UTC', 1, 1, 1);
	`);
	toggle(db, "booking", false);
	const { planned, skipped } = await runModuleTriageSteps(stepInput(env));
	assert.deepEqual(skipped, []);
	const slots = planned[0].payload.proposals;
	assert.ok(slots.length > 0, "slots were proposed");
	for (const slot of slots) {
		const start = localTime(slot.start, ZONE);
		const end = localTime(slot.end, ZONE);
		assert.ok(["Mon", "Tue", "Wed", "Thu", "Fri"].includes(start.weekday), `${slot.start} is on ${start.weekday}`);
		assert.ok(start.minutes >= 540 && end.minutes <= 1020, `${slot.start} is outside 09:00-17:00 ${ZONE}`);
	}
});

test("a user with no booking event type gets the default week", async (t) => {
	const { db, env } = await setup(t);
	conflictingEvent(db);
	const { planned } = await runModuleTriageSteps(stepInput(env));
	for (const slot of planned[0].payload.proposals) {
		const start = localTime(slot.start, ZONE);
		assert.ok(["Mon", "Tue", "Wed", "Thu", "Fri"].includes(start.weekday));
		assert.ok(start.minutes >= 540 && localTime(slot.end, ZONE).minutes <= 1020);
	}
});

test("a module action writes its pending row before the module runs, then marks it applied and keeps the inverse", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	const result = await acceptSuggestion(env, owner, "sugg-1", "accept");
	assert.equal(result.status, "accepted");
	assert.deepEqual(
		db.db
			.prepare("SELECT pending FROM probe")
			.all()
			.map((row) => row.pending),
		[1],
		"the create_event row was pending when the event was inserted",
	);
	const [created] = actions(db, "action = 'create_event'");
	assert.equal(created.status, "applied");
	const [event] = events(db);
	assert.equal(JSON.parse(created.after).eventId, event.id);
	assert.deepEqual(JSON.parse(created.before), { eventId: event.id });
	assert.equal(event.id, `evt_${created.id.replace(/^aact_/, "")}`, "ids derive from the action id");
});

test("a refused module action is recorded as failed with the module's reason", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	const result = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "create_event",
		initiator: "user",
		actingUserId: "owner",
		permissions: { canManage: true, canSendOnBehalf: true },
		module: {
			input: { variant: "", payload: { uid: 1 }, reviewerUserId: "owner", messageId: "source-1" },
			viewer: { ...viewer, timeZone: "UTC" },
		},
	});
	assert.equal(result.status, "failed");
	assert.deepEqual(events(db), []);
	assert.equal(actions(db)[0].status, "failed");
	assert.ok(actions(db)[0].reason);
});

test("a stale pending module action resumes with its action id and the event is added once", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	const stale = Math.floor(Date.now() / 1000) - 3600;
	db.db
		.prepare(
			"INSERT INTO agent_actions (id, mailbox_id, suggestion_id, message_id, initiator, acting_user_id, action, variant, status, after, created_at, updated_at) VALUES ('aact_stale', 'mailbox-a', 'sugg-1', 'source-1', 'user', 'owner', 'create_event', '', 'pending', '{}', ?, ?)",
		)
		.run(stale, stale);
	const input = {
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "create_event",
		initiator: "user",
		actingUserId: "owner",
		permissions: { canManage: true, canSendOnBehalf: true },
		module: {
			input: { variant: "", payload: payload(), reviewerUserId: "owner", messageId: "source-1" },
			viewer: { ...viewer, timeZone: "UTC" },
		},
	};
	const resumed = await executeAction(input);
	assert.equal(resumed.status, "applied");
	assert.equal(resumed.actionId, "aact_stale");
	assert.equal(events(db).length, 1);
	assert.equal(events(db)[0].id, "evt_stale");

	// The same action id again, as after a crash between the effect and the row update.
	const ctx = buildCallContext({
		trigger: "api",
		viewer,
		timeZone: "UTC",
		mailboxIds: ["mailbox-a"],
		grants: ["calendar.write"],
	});
	const again = await invokeCapability(
		"calendar",
		"createEvent",
		{ op: "execute", actionId: "aact_stale", suggestion: { id: "sugg-1" }, input: input.module.input },
		ctx,
	);
	assert.equal(again.ok, true);
	assert.equal(events(db).length, 1);
});

function legacyRow(db, { id, action, after, variant = "" }) {
	const stale = Math.floor(Date.now() / 1000) - 3600;
	db.db
		.prepare(
			"INSERT INTO agent_actions (id, mailbox_id, suggestion_id, message_id, initiator, acting_user_id, action, variant, status, after, created_at, updated_at) VALUES (?, 'mailbox-a', 'sugg-1', 'source-1', 'user', 'owner', ?, ?, 'pending', ?, ?, ?)",
		)
		.run(id, action, variant, JSON.stringify(after), stale, stale);
}

const rsvpModuleInput = (extra = {}) => ({
	env: undefined,
	mailboxId: "mailbox-a",
	suggestionId: "sugg-1",
	messageId: "source-1",
	action: "send_rsvp",
	variant: "accepted",
	initiator: "user",
	actingUserId: "owner",
	permissions: { canManage: true, canSendOnBehalf: true },
	module: {
		input: {
			partstat: "accepted",
			payload: payload(),
			sourceMessageId: "source-1",
			suggestionId: "sugg-1",
			mailboxId: "mailbox-a",
		},
		viewer: { ...viewer, timeZone: "UTC" },
	},
	...extra,
});

test("a pending RSVP row from the previous release resumes under its stored message id and sends nothing", async (t) => {
	const { db, env, sent } = await setup(t);
	addSuggestion(db);
	legacyRow(db, {
		id: "aact_legacyrsvp",
		action: "send_rsvp",
		variant: "accepted",
		after: { messageId: "msg_legacy" },
	});
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
		VALUES ('msg_legacy', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'alice@partner.test', 'Accepted: Planning', 'sent', 1);
	`);
	const result = await executeAction(rsvpModuleInput({ env }));
	assert.equal(result.status, "applied");
	assert.equal(result.actionId, "aact_legacyrsvp");
	assert.equal(result.after.messageId, "msg_legacy");
	assert.equal(sent.length, 0);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages WHERE direction = 'outbound'").get().n, 1);
	const [row] = actions(db, "id = 'aact_legacyrsvp'");
	assert.equal(row.status, "applied");
	assert.equal(JSON.parse(row.after).messageId, "msg_legacy");
	assert.equal(JSON.parse(row.before).messageId, "msg_legacy");
});

test("a pending RSVP row whose message was never written sends once under the stored id", async (t) => {
	const { db, env, sent } = await setup(t);
	addSuggestion(db);
	legacyRow(db, {
		id: "aact_legacyrsvp2",
		action: "send_rsvp",
		variant: "accepted",
		after: { messageId: "msg_stored" },
	});
	const result = await executeAction(rsvpModuleInput({ env }));
	assert.equal(result.status, "applied");
	assert.equal(sent.length, 1);
	assert.equal(result.after.messageId, "msg_stored");
	assert.ok(db.db.prepare("SELECT id FROM messages WHERE id = 'msg_stored'").get());
});

test("a pending create_event row from the previous release resolves to its stored event without a duplicate", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	legacyRow(db, { id: "aact_legacyevent", action: "create_event", after: { eventId: "evt_legacy" } });
	db.db.exec(`
		INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, ical_uid, created_at, updated_at)
		VALUES ('evt_legacy', 'owner', 'Planning', ${START / 1000}, ${(START + 3_600_000) / 1000}, 'uid-1@partner.test', 1, 1);
	`);
	const result = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "create_event",
		initiator: "user",
		actingUserId: "owner",
		permissions: { canManage: true, canSendOnBehalf: true },
		module: {
			input: { variant: "", payload: payload(), reviewerUserId: "owner", messageId: "source-1" },
			viewer: { ...viewer, timeZone: "UTC" },
		},
	});
	assert.equal(result.status, "applied");
	assert.equal(result.after.eventId, "evt_legacy");
	assert.equal(events(db).length, 1);
});

test("a new module action stores no ids up front and derives its effect ids from the action id", async (t) => {
	const { db, env, sent } = await setup(t);
	addSuggestion(db);
	const result = await executeAction(rsvpModuleInput({ env }));
	assert.equal(result.status, "applied");
	assert.equal(sent.length, 1);
	assert.equal(result.after.messageId, `msg_${result.actionId.replace(/^aact_/, "")}`);
});

test("an RSVP repeated with the same action id sends one reply", async (t) => {
	const { db, sent } = await setup(t);
	addSuggestion(db);
	const ctx = buildCallContext({
		trigger: "api",
		viewer,
		timeZone: "UTC",
		mailboxIds: ["mailbox-a"],
		grants: ["calendar.write"],
	});
	const call = {
		op: "execute",
		actionId: "aact_rsvp-1",
		suggestion: { id: "sugg-1" },
		input: {
			partstat: "accepted",
			payload: payload(),
			sourceMessageId: "source-1",
			suggestionId: "sugg-1",
			mailboxId: "mailbox-a",
		},
	};
	const first = await invokeCapability("calendar", "sendRsvp", call, ctx);
	const second = await invokeCapability("calendar", "sendRsvp", call, ctx);
	assert.equal(first.ok && !first.output.refused, true, JSON.stringify(first));
	assert.equal(second.ok && !second.output.refused, true);
	assert.equal(sent.length, 1);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages WHERE direction = 'outbound'").get().n, 1);
});

test("with Calendar off accepting an invitation answers module_disabled and creates no event", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	toggle(db, "calendar", false);
	await assert.rejects(
		() => acceptSuggestion(env, owner, "sugg-1", "accept"),
		(error) => error.status === 409 && error.code === "module_disabled" && /Calendar is turned off/.test(error.message),
	);
	assert.deepEqual(events(db), []);
	assert.deepEqual(actions(db), []);
});

test("executing a module action while the module is off is blocked with the module id", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	toggle(db, "calendar", false);
	const result = await executeAction({
		env,
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "source-1",
		action: "create_event",
		initiator: "user",
		actingUserId: "owner",
		permissions: { canManage: true, canSendOnBehalf: true },
		module: {
			input: { variant: "", payload: payload(), reviewerUserId: "owner", messageId: "source-1" },
			viewer: { ...viewer, timeZone: "UTC" },
		},
	});
	assert.equal(result.status, "blocked");
	assert.equal(result.reason, "module_disabled:calendar");
	assert.deepEqual(events(db), []);
	assert.deepEqual(
		actions(db).map((row) => [row.action, row.status, row.reason]),
		[["create_event", "blocked", "module_disabled:calendar"]],
	);
});

test("undo is refused while Calendar is off, recorded as blocked, and works again once it is on", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	await acceptSuggestion(env, owner, "sugg-1", "accept");
	const [created] = actions(db, "action = 'create_event'");
	assert.equal(events(db).length, 1);

	toggle(db, "calendar", false);
	await assert.rejects(
		() => undoAgentAction(env, owner, created.id),
		(error) => error.status === 409 && error.code === "module_disabled",
	);
	assert.equal(events(db).length, 1, "the event is still there");
	assert.equal(actions(db, `id = '${created.id}'`)[0].status, "applied");
	const blocked = actions(db, "status = 'blocked'");
	assert.deepEqual(
		blocked.map((row) => [row.action, row.variant, row.reason]),
		[["delete_event", `undo:${created.id}`, "module_disabled:calendar"]],
	);

	toggle(db, "calendar", true);
	const undone = await undoAgentAction(env, owner, created.id);
	assert.equal(undone.actionId, created.id);
	assert.equal(events(db).length, 0);
	const [inverse] = actions(db, `variant = 'undo:${created.id}' AND status = 'applied'`);
	assert.equal(inverse.action, "delete_event");
	assert.equal(actions(db, `id = '${created.id}'`)[0].status, "undone");
});

test("undo passes the stored inverse back, and a row written before module actions existed still undoes", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	db.db.exec(`
		INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, ical_uid, created_at, updated_at)
		VALUES ('evt-old', 'owner', 'Planning', ${START / 1000}, ${(START + 3_600_000) / 1000}, 'uid-1@partner.test', 1, 1);
	`);
	const now = Math.floor(Date.now() / 1000);
	db.db
		.prepare(
			"INSERT INTO agent_actions (id, mailbox_id, suggestion_id, message_id, initiator, acting_user_id, action, variant, status, before, after, undo_until, created_at, updated_at) VALUES ('aact_old', 'mailbox-a', 'sugg-1', 'source-1', 'user', 'owner', 'create_event', '', 'applied', NULL, '{\"eventId\":\"evt-old\"}', ?, ?, ?)",
		)
		.run(now + 3600, now, now);
	await undoAgentAction(env, owner, "aact_old");
	assert.equal(events(db).length, 0);
	assert.equal(actions(db, "id = 'aact_old'")[0].status, "undone");
});

test("a module off for the viewer hides its suggestion kinds from lists and counts, and they return unchanged", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	db.db.exec(
		"INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES ('sugg-sum', 'mailbox-a', 'source-1', 'owner', 'summary', 'open', 'Summary', '{\"text\":\"Hi\"}', 1)",
	);
	const list = () => listSuggestions(env, owner, { mailboxId: null, status: "open" });
	const before = await list();
	assert.deepEqual(before.suggestions.map((row) => row.kind).sort(), ["calendar_invite", "summary"]);
	assert.equal(before.total, 2);

	toggle(db, "calendar", false);
	const during = await list();
	assert.deepEqual(
		during.suggestions.map((row) => row.kind),
		["summary"],
	);
	assert.equal(during.total, 1);
	assert.deepEqual(during.kindTotals, { summary: 1 });

	toggle(db, "calendar", true);
	const after = await list();
	assert.deepEqual(after.suggestions.map((row) => row.id).sort(), before.suggestions.map((row) => row.id).sort());
	assert.equal(after.total, 2);
});

test("the message row badge leaves out kinds the viewer's modules own while they are off", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	const mailboxes = [{ id: "mailbox-a", permission: "full_access" }];
	const rows = [{ id: "source-1", mailboxId: "mailbox-a", threadId: null }];
	const badge = async (hidden) =>
		(await loadRowSuggestions(getDb(env), mailboxes, rows, new Map(), hidden))("source-1").agentSuggestions ?? [];
	assert.equal((await badge([])).length, 1);
	assert.deepEqual(await badge(["calendar_invite"]), []);
});

test("a per-user restriction hides the kinds for that user only", async (t) => {
	const { db, env } = await setup(t);
	addSuggestion(db);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at, updated_by) VALUES ('access-1', 'owner', 'calendar', 0, 1, 'owner')",
	);
	clearModuleStateCache();
	const result = await listSuggestions(env, owner, { mailboxId: null, status: "open" });
	assert.deepEqual(result.suggestions, []);
});

test("Activity lists a completed triage job that skipped a module's step, and skipped jobs as before", async (t) => {
	const { db, env } = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	const insertMessage = db.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'a@partner.test', 'support@example.com', 'Hi', 'Hi', 'received', 1)",
	);
	const insert = db.db.prepare(
		"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, reason, next_attempt_at, created_at) VALUES (?, 'mailbox-a', ?, 'owner', 'triage', ?, ?, 1, ?)",
	);
	for (const [id, status, reason, created] of [
		["job-module", "completed", "module_disabled:calendar", now],
		["job-plain", "completed", null, now],
		["job-skipped", "skipped", "paused", now - 1],
	]) {
		insertMessage.run(`msg-${id}`);
		insert.run(id, `msg-${id}`, status, reason, created);
	}
	const activity = await listAgentActivity(env, "mailbox-a", viewer.userId);
	assert.deepEqual(
		activity.skippedJobs.map((job) => [job.id, job.reason]),
		[
			["job-module", "module_disabled:calendar"],
			["job-skipped", "paused"],
		],
	);
});
