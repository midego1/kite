import assert from "node:assert/strict";
import { join } from "node:path";
import test, { mock } from "node:test";
import { z } from "zod";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	MODULE_MANIFESTS,
	effectiveModules,
	CORE_WEBHOOK_EVENTS,
	WEBHOOK_EVENT_CATALOG,
	WEBHOOK_EVENT_VALUES,
	availableWebhookEvents,
	webhookEventOptions,
	webhookEventOwner,
	webhookEventRefusal,
	moduleDisabledNote,
	createWebhookEmitter,
	WebhookEmitError,
	webhookSchema,
	webhookUpdateSchema,
	moduleHost,
	dispatchWebhooks,
	processWebhookRetry,
	runDelivery,
	runCalendarTool,
	runCalendarAction,
	createBookedCalendarEvents,
	serializeEventRow,
	setModuleEnabled,
	calendarEventWebhookPayload,
	bookingAppointmentPayload,
	calendarCapabilities,
	bookingCapabilities,
	financeCapabilities,
} = await bundleModules("kite-module-webhooks-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["effectiveModules", "src/lib/modules/state-utils.ts"],
	[
		"CORE_WEBHOOK_EVENTS, WEBHOOK_EVENT_CATALOG, WEBHOOK_EVENT_VALUES, availableWebhookEvents, webhookEventOptions, webhookEventOwner, webhookEventRefusal, moduleDisabledNote",
		"src/lib/modules/webhook-events-utils.ts",
	],
	["createWebhookEmitter, WebhookEmitError", "src/lib/modules/webhook-emit-utils.ts"],
	["webhookSchema, webhookUpdateSchema", "src/lib/validators.ts"],
	["moduleHost", "src/lib/modules/host.ts"],
	["dispatchWebhooks, processWebhookRetry, runDelivery", "src/lib/email/webhooks.ts"],
	["runCalendarTool", "src/lib/calendar/tools.ts"],
	["runCalendarAction", "src/lib/agent/auto-read/calendar-actions.ts"],
	["createBookedCalendarEvents", "src/lib/booking/create.ts"],
	["serializeEventRow", "src/lib/agent/auto-read/invite-actions-utils.ts"],
	["setModuleEnabled", "src/lib/modules/state.ts"],
	["calendarEventWebhookPayload", "src/lib/calendar/webhook-event-utils.ts"],
	["bookingAppointmentPayload", "src/lib/booking/webhook-event-utils.ts"],
	["calendarCapabilities", "src/lib/modules/calendar/capabilities.ts"],
	["bookingCapabilities", "src/lib/modules/booking/capabilities.ts"],
	["financeCapabilities", "src/lib/modules/finance/capabilities.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance"];
const install = (off = []) => new Map(ALL.map((id) => [id, !off.includes(id)]));
const enabledWith = (off) => [...effectiveModules(install(off), new Map(), MODULE_MANIFESTS)];
const ids = (events) => events.map((event) => event.value);

const MESSAGE_EVENTS = ["message.inbound", "message.outbound", "message.failed"];
const CALENDAR_EVENTS = ["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"];
const BOOKING_EVENT = "booking.appointment.created";
const FINANCE_EVENTS = ["finance.subscription.detected", "finance.subscription.renewal_due"];
const ALL_EVENTS = [...MESSAGE_EVENTS, ...CALENDAR_EVENTS, BOOKING_EVENT, ...FINANCE_EVENTS];

const OWNER = { userId: "owner", role: "admin", isPrimaryAdmin: true };
const ctxFor = (viewer = OWNER) => ({
	viewer,
	requestId: "req-1",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "api",
});

test("one registry list holds the core events and every module's events with their manifest labels", () => {
	assert.deepEqual(ids(WEBHOOK_EVENT_CATALOG), ALL_EVENTS);
	assert.deepEqual(WEBHOOK_EVENT_VALUES, ALL_EVENTS);
	assert.deepEqual(ids(CORE_WEBHOOK_EVENTS), MESSAGE_EVENTS);
	const byValue = new Map(WEBHOOK_EVENT_CATALOG.map((event) => [event.value, event]));
	assert.equal(byValue.get("calendar.event.created").label, "Calendar event created");
	assert.equal(byValue.get(BOOKING_EVENT).label, "Appointment booked");
	assert.equal(webhookEventOwner(WEBHOOK_EVENT_CATALOG, "calendar.event.updated"), "calendar");
	assert.equal(webhookEventOwner(WEBHOOK_EVENT_CATALOG, BOOKING_EVENT), "booking");
	assert.equal(byValue.get("finance.subscription.renewal_due").label, "Subscription renewal due");
	assert.equal(webhookEventOwner(WEBHOOK_EVENT_CATALOG, "finance.subscription.detected"), "finance");
	assert.equal(webhookEventOwner(WEBHOOK_EVENT_CATALOG, "message.failed"), null);
	assert.equal(webhookEventOwner(WEBHOOK_EVENT_CATALOG, "foo.bar"), undefined);
});

test("every module event of the manifests is declared by a webhook_event descriptor with the same value", () => {
	const declared = [calendarCapabilities, bookingCapabilities, financeCapabilities].flatMap((entry) =>
		entry.descriptors.filter((d) => d.surfaces.includes("webhook_event")).map((d) => d.event.value),
	);
	assert.deepEqual(declared.sort(), [...CALENDAR_EVENTS, BOOKING_EVENT, ...FINANCE_EVENTS].sort());
	assert.deepEqual(
		MODULE_MANIFESTS.flatMap((manifest) => manifest.webhookEvents.map((event) => event.value)).sort(),
		declared.sort(),
	);
});

test("the picker lists only the events of modules that are on", () => {
	assert.deepEqual(ids(availableWebhookEvents(WEBHOOK_EVENT_CATALOG, enabledWith([]))), ALL_EVENTS);
	assert.deepEqual(ids(availableWebhookEvents(WEBHOOK_EVENT_CATALOG, enabledWith(["booking"]))), [
		...MESSAGE_EVENTS,
		...CALENDAR_EVENTS,
		...FINANCE_EVENTS,
	]);
	assert.deepEqual(ids(availableWebhookEvents(WEBHOOK_EVENT_CATALOG, enabledWith(["calendar"]))), [
		...MESSAGE_EVENTS,
		...FINANCE_EVENTS,
	]);
	assert.deepEqual(
		ids(availableWebhookEvents(WEBHOOK_EVENT_CATALOG, enabledWith(["calendar", "finance"]))),
		MESSAGE_EVENTS,
	);
	assert.deepEqual(ids(availableWebhookEvents(WEBHOOK_EVENT_CATALOG, [])), MESSAGE_EVENTS);
});

test("the API catalog holds only the events of modules that are on, as value, label and hint", () => {
	const listed = (off) => webhookEventOptions(WEBHOOK_EVENT_CATALOG, enabledWith(off));
	assert.deepEqual(ids(listed([])), ALL_EVENTS);
	assert.deepEqual(ids(listed(["booking"])), [...MESSAGE_EVENTS, ...CALENDAR_EVENTS, ...FINANCE_EVENTS]);
	assert.ok(!ids(listed(["booking"])).includes(BOOKING_EVENT));
	assert.deepEqual(ids(listed(["calendar"])), [...MESSAGE_EVENTS, ...FINANCE_EVENTS]);
	assert.deepEqual(ids(listed(["calendar", "booking", "finance"])), MESSAGE_EVENTS);
	assert.deepEqual(ids(listed(["finance"])), [...MESSAGE_EVENTS, ...CALENDAR_EVENTS, BOOKING_EVENT]);
	for (const option of listed([])) {
		assert.deepEqual(Object.keys(option).sort(), ["hint", "label", "value"]);
	}
	assert.equal(listed([]).find((option) => option.value === BOOKING_EVENT).label, "Appointment booked");
});

test("the validators accept every listed event at once and reject unknown ones", () => {
	const base = { url: "https://hooks.kite-validation.invalid/sink" };
	assert.equal(webhookSchema.safeParse({ ...base, events: ALL_EVENTS }).success, true);
	assert.equal(webhookUpdateSchema.safeParse({ events: ALL_EVENTS }).success, true);
	assert.equal(webhookSchema.safeParse({ ...base, events: [...ALL_EVENTS, "message.inbound"] }).success, false);
	assert.equal(webhookSchema.safeParse({ ...base, events: ["foo.bar"] }).success, false);
	assert.equal(webhookSchema.safeParse({ ...base, events: [] }).success, false);
	assert.equal(webhookUpdateSchema.safeParse({ events: ["foo.bar"] }).success, false);
	assert.equal(webhookUpdateSchema.safeParse({ description: "unrelated" }).success, true);
});

test("adding a disabled module's event is refused with MODULE_DISABLED, naming the module", () => {
	const refusal = webhookEventRefusal(WEBHOOK_EVENT_CATALOG, enabledWith(["calendar"]), ["calendar.event.created"]);
	assert.equal(refusal.status, 400);
	assert.equal(refusal.body.code, "MODULE_DISABLED");
	assert.equal(refusal.body.moduleId, "calendar");
	assert.match(refusal.body.error, /Calendar is turned off/);
	const booking = webhookEventRefusal(WEBHOOK_EVENT_CATALOG, enabledWith(["booking"]), [BOOKING_EVENT]);
	assert.equal(booking.body.moduleId, "booking");
	assert.equal(webhookEventRefusal(WEBHOOK_EVENT_CATALOG, enabledWith(["calendar"]), MESSAGE_EVENTS), null);
	assert.equal(webhookEventRefusal(WEBHOOK_EVENT_CATALOG, enabledWith([]), ALL_EVENTS), null);
});

test("an event the webhook already holds is never refused, so unrelated edits keep it", () => {
	const off = enabledWith(["calendar"]);
	assert.equal(
		webhookEventRefusal(
			WEBHOOK_EVENT_CATALOG,
			off,
			["message.inbound", "calendar.event.created"],
			["message.inbound", "calendar.event.created"],
		),
		null,
	);
	const added = webhookEventRefusal(
		WEBHOOK_EVENT_CATALOG,
		off,
		["message.inbound", "calendar.event.created", "calendar.event.deleted"],
		["message.inbound", "calendar.event.created"],
	);
	assert.equal(added.body.code, "MODULE_DISABLED");
});

test("the note for a dropped delivery names the module and is absent for core events", () => {
	assert.equal(
		moduleDisabledNote(WEBHOOK_EVENT_CATALOG, "calendar.event.created"),
		"module_disabled: Calendar is turned off",
	);
	assert.equal(moduleDisabledNote(WEBHOOK_EVENT_CATALOG, "message.inbound"), null);
});

const emitterDeps = (overrides = {}) => {
	const dispatched = [];
	const schema = z.object({ ref: z.object({ kind: z.string(), id: z.string() }) });
	return {
		dispatched,
		deps: {
			owner: (event) => webhookEventOwner(WEBHOOK_EVENT_CATALOG, event),
			payloadSchema: async () => schema,
			isEnabledFor: async () => true,
			dispatch: async (userId, event, payload) => void dispatched.push({ userId, event, payload }),
			...overrides,
		},
	};
};
const goodPayload = { ref: { kind: "calendar:event", id: "evt_1" } };

test("emitWebhook refuses an event that belongs to another module, an unknown event and a core event", async () => {
	const { deps, dispatched } = emitterDeps();
	const emit = createWebhookEmitter(deps);
	await assert.rejects(() => emit(ctxFor(), "booking", "calendar.event.created", goodPayload), WebhookEmitError);
	await assert.rejects(() => emit(ctxFor(), "calendar", BOOKING_EVENT, goodPayload), /does not belong/);
	await assert.rejects(() => emit(ctxFor(), "calendar", "foo.bar", goodPayload), /Unknown webhook event/);
	await assert.rejects(() => emit(ctxFor(), "calendar", "message.inbound", goodPayload), /does not belong/);
	assert.deepEqual(dispatched, []);
});

test("emitWebhook refuses a payload that fails the event's schema or is not JSON", async () => {
	const { deps, dispatched } = emitterDeps();
	const emit = createWebhookEmitter(deps);
	await assert.rejects(
		() => emit(ctxFor(), "calendar", "calendar.event.created", { ref: { kind: "x" } }),
		/Invalid payload/,
	);
	await assert.rejects(() => emit(ctxFor(), "calendar", "calendar.event.created", null), /Invalid payload/);
	await assert.rejects(() => emit(ctxFor(), "calendar", "calendar.event.created", { ref: () => 1 }), WebhookEmitError);
	assert.deepEqual(dispatched, []);
});

test("emitWebhook needs an acting user, drops events of a module that is off and dispatches otherwise", async () => {
	const { deps, dispatched } = emitterDeps({ isEnabledFor: async (viewer) => viewer.userId === "owner" });
	const emit = createWebhookEmitter(deps);
	await assert.rejects(() => emit(ctxFor(null), "calendar", "calendar.event.created", goodPayload), /acting user/);
	await emit(
		ctxFor({ userId: "member", role: "user", isPrimaryAdmin: false }),
		"calendar",
		"calendar.event.created",
		goodPayload,
	);
	assert.deepEqual(dispatched, []);
	await emit(ctxFor(), "calendar", "calendar.event.created", goodPayload);
	assert.deepEqual(dispatched, [{ userId: "owner", event: "calendar.event.created", payload: goodPayload }]);
});

const previousEnv = globalThis.__kiteNodeEnv;
const realFetch = globalThis.fetch;
test.after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
	globalThis.fetch = realFetch;
});

const HOOK_URL = "https://hooks.kite-validation.invalid/sink";

async function setup(t, { events = ALL_EVENTS, status = 500 } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, time_zone, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 'UTC', 1),
			('member', 'member@example.com', 'hash', 'Member', 'user', 0, 'UTC', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('msg-1', 'owner', 'mailbox-a', 'inbound', 'alice@partner.test', 'a@example.com', 'Invite', 'Join', 'received', 1);
		INSERT INTO booking_events (id, user_id, name, slug, duration_minutes, host_ids, created_at, updated_at)
			VALUES ('type-1', 'owner', 'Intro', 'intro', 30, '["owner","member"]', 1, 1);
	`);
	db.db
		.prepare(
			"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES ('wh1', 'owner', ?, 'whsec_test', ?, 1, 3, 1)",
		)
		.run(HOOK_URL, JSON.stringify(events));
	const queued = [];
	const env = { DB: db, OUTBOUND_QUEUE: { send: async (message) => void queued.push(message) } };
	globalThis.__kiteNodeEnv = env;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, body: init.body });
		return new Response("down", { status });
	};
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const deliveries = () =>
		db.db
			.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at, rowid")
			.all()
			.map((row) => ({ ...row, body: JSON.parse(row.payload) }));
	return { db, env, queued, calls, deliveries };
}

const user = (overrides = {}) => ({
	id: "owner",
	role: "admin",
	isPrimaryAdmin: true,
	timeZone: "UTC",
	...overrides,
});

test("a module event is delivered inline in the existing envelope with its ref and record, and retried on failure", async (t) => {
	const { calls, deliveries, queued } = await setup(t);
	const payload = calendarEventWebhookPayload({
		id: "evt_1",
		title: "Review",
		startsAt: new Date("2030-01-01T10:00:00Z"),
		endsAt: new Date("2030-01-01T11:00:00Z"),
		timeZone: "Europe/Amsterdam",
	});
	await moduleHost.emitWebhook(ctxFor(), "calendar", "calendar.event.created", payload);
	const [delivery] = deliveries();
	assert.equal(delivery.event_type, "calendar.event.created");
	assert.equal(delivery.status, "retrying");
	assert.equal(delivery.attempts, 1);
	assert.deepEqual(delivery.body, { type: "calendar.event.created", data: payload });
	assert.deepEqual(delivery.body.data.ref, { kind: "calendar:event", id: "evt_1" });
	assert.deepEqual(delivery.body.data.event, {
		id: "evt_1",
		title: "Review",
		start: "2030-01-01T10:00:00.000Z",
		end: "2030-01-01T11:00:00.000Z",
		timeZone: "Europe/Amsterdam",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].headers["X-Email-Platform-Event"], "calendar.event.created");
	assert.deepEqual(queued, [{ kind: "webhook.retry", deliveryId: delivery.id }]);
});

test("moduleHost.emitWebhook refuses another module's event and an invalid payload, writing nothing", async (t) => {
	const { deliveries, calls } = await setup(t);
	const payload = calendarEventWebhookPayload({
		id: "evt_1",
		title: "Review",
		startsAt: new Date(0),
		endsAt: new Date(1000),
		timeZone: "UTC",
	});
	await assert.rejects(
		() => moduleHost.emitWebhook(ctxFor(), "booking", "calendar.event.created", payload),
		/does not belong/,
	);
	await assert.rejects(
		() =>
			moduleHost.emitWebhook(ctxFor(), "calendar", "calendar.event.created", {
				ref: { kind: "calendar:event", id: "x" },
			}),
		/Invalid payload/,
	);
	await assert.rejects(
		() =>
			moduleHost.emitWebhook(ctxFor(), "calendar", "calendar.event.created", {
				...payload,
				event: { ...payload.event, start: "not a date" },
			}),
		/Invalid payload/,
	);
	assert.deepEqual(deliveries(), []);
	assert.equal(calls.length, 0);
});

test("nothing is emitted while the module is off, and writes emit again once it is back on", async (t) => {
	const { env, deliveries } = await setup(t);
	const context = { env, user: user(), timeZone: "UTC" };
	const create = (title) =>
		runCalendarTool(context, "create_event", {
			title,
			startsAt: "2030-01-01T10:00:00Z",
			endsAt: "2030-01-01T11:00:00Z",
		});
	await setModuleEnabled(env, { moduleId: "calendar", enabled: false, updatedBy: null });
	await create("While off");
	assert.deepEqual(deliveries(), []);
	await setModuleEnabled(env, { moduleId: "calendar", enabled: true, updatedBy: null });
	await create("Back on");
	assert.deepEqual(
		deliveries().map((row) => row.event_type),
		["calendar.event.created"],
	);
	assert.equal(deliveries()[0].body.data.event.title, "Back on");
});

test("a retry that runs while the module is off is dropped with a module_disabled note, and a manual retry works once it is on", async (t) => {
	const { env, deliveries, calls, queued } = await setup(t);
	await runCalendarTool({ env, user: user(), timeZone: "UTC" }, "create_event", {
		title: "Review",
		startsAt: "2030-01-01T10:00:00Z",
		endsAt: "2030-01-01T11:00:00Z",
	});
	const [pending] = deliveries();
	assert.equal(pending.status, "retrying");
	assert.equal(calls.length, 1);
	await setModuleEnabled(env, { moduleId: "calendar", enabled: false, updatedBy: null });
	await processWebhookRetry(env, queued[0]);
	assert.equal(calls.length, 1, "the endpoint is not called while the module is off");
	const [dropped] = deliveries();
	assert.equal(dropped.status, "failed");
	assert.equal(dropped.next_retry_at, null);
	assert.equal(dropped.attempts, 1);
	assert.match(dropped.error, /^module_disabled: Calendar is turned off/);
	assert.equal(queued.length, 1, "no further retry is scheduled");
	await setModuleEnabled(env, { moduleId: "calendar", enabled: true, updatedBy: null });
	const retried = await runDelivery(env, pending.id);
	assert.equal(calls.length, 2);
	assert.equal(retried.status, "retrying");
});

test("Booking off drops booking retries but keeps calendar ones", async (t) => {
	const { env, deliveries, calls, queued } = await setup(t);
	const context = { env, user: user(), timeZone: "UTC" };
	await runCalendarTool(context, "create_event", {
		title: "Review",
		startsAt: "2030-01-01T10:00:00Z",
		endsAt: "2030-01-01T11:00:00Z",
	});
	await setModuleEnabled(env, { moduleId: "booking", enabled: false, updatedBy: null });
	await processWebhookRetry(env, queued[0]);
	assert.equal(calls.length, 2);
	assert.equal(deliveries()[0].status, "retrying");
});

test("message events are unaffected with every module off: same envelope, no ref", async (t) => {
	const { env, deliveries, calls } = await setup(t, { events: MESSAGE_EVENTS, status: 200 });
	for (const moduleId of ALL) await setModuleEnabled(env, { moduleId, enabled: false, updatedBy: null });
	const data = { messageId: "m1", from: "a@example.net", to: "b@example.com", subject: "Hi" };
	await dispatchWebhooks(env, "owner", "message.inbound", data);
	await dispatchWebhooks(env, "owner", "message.outbound", data);
	await dispatchWebhooks(env, "owner", "message.failed", { messageId: "m1", error: "boom" });
	assert.deepEqual(
		deliveries().map((row) => [row.event_type, row.status]),
		[
			["message.inbound", "delivered"],
			["message.outbound", "delivered"],
			["message.failed", "delivered"],
		],
	);
	assert.deepEqual(deliveries()[0].body, { type: "message.inbound", data });
	assert.equal("ref" in deliveries()[0].body.data, false);
	assert.equal(calls.length, 3);
});

test("a webhook that does not hold the event gets nothing, and the owner's other webhooks are separate", async (t) => {
	const { deliveries } = await setup(t, { events: ["message.inbound"] });
	await moduleHost.emitWebhook(
		ctxFor(),
		"calendar",
		"calendar.event.created",
		calendarEventWebhookPayload({
			id: "e",
			title: "t",
			startsAt: new Date(0),
			endsAt: new Date(1000),
			timeZone: "UTC",
		}),
	);
	assert.deepEqual(deliveries(), []);
});

test("every calendar write path emits one event with a calendar:event ref: tool create, update and delete", async (t) => {
	const { env, deliveries } = await setup(t);
	const context = { env, user: user(), timeZone: "UTC" };
	const created = await runCalendarTool(context, "create_event", {
		title: "Planning",
		startsAt: "2030-02-01T10:00:00Z",
		endsAt: "2030-02-01T11:00:00Z",
		timeZone: "UTC",
	});
	await runCalendarTool(context, "update_events", { updates: [{ eventId: created.eventId, title: "Planning v2" }] });
	await runCalendarTool(context, "delete_events", { eventIds: [created.eventId] });
	const rows = deliveries();
	assert.deepEqual(
		rows.map((row) => row.event_type),
		["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"],
	);
	for (const row of rows) {
		assert.deepEqual(row.body.data.ref, { kind: "calendar:event", id: created.eventId });
		assert.equal(row.body.data.event.id, created.eventId);
		assert.equal(row.body.data.event.timeZone, "UTC");
	}
	assert.deepEqual(
		rows.map((row) => row.body.data.event.title),
		["Planning", "Planning v2", "Planning v2"],
	);
});

const invite = (overrides = {}) => ({
	uid: "uid-1@partner.test",
	sequence: 0,
	method: "REQUEST",
	organizer: "alice@partner.test",
	start: "2030-03-01T10:00:00.000Z",
	end: "2030-03-01T11:00:00.000Z",
	tz: "UTC",
	summary: "Sync",
	location: null,
	repeats: false,
	conflicts: [],
	proposals: [],
	organizerMatchesSender: true,
	authPassed: true,
	...overrides,
});

test("invite actions emit created, updated and deleted events", async (t) => {
	const { env, deliveries, db } = await setup(t);
	const ctx = { ...ctxFor(), grants: ["calendar.read", "calendar.write"] };
	const run = (name, input) =>
		runCalendarAction(env, ctx, name, { op: "execute", actionId: `aact_${name}${Math.random()}`, input });
	const created = await run("createEvent", {
		variant: "",
		payload: invite(),
		reviewerUserId: "owner",
		messageId: "msg-1",
	});
	const eventId = created.result.eventId;
	assert.match(eventId, /^evt_/);
	await run("createEvent", {
		variant: "update",
		payload: invite({
			sequence: 1,
			summary: "Sync (moved)",
			start: "2030-03-01T12:00:00.000Z",
			end: "2030-03-01T13:00:00.000Z",
		}),
		reviewerUserId: "owner",
		messageId: "msg-1",
	});
	await run("deleteEvent", { eventId, uid: "uid-1@partner.test", reviewerUserId: "owner" });
	assert.deepEqual(
		deliveries().map((row) => [row.event_type, row.body.data.ref.id, row.body.data.event.title]),
		[
			["calendar.event.created", eventId, "Sync"],
			["calendar.event.updated", eventId, "Sync (moved)"],
			["calendar.event.deleted", eventId, "Sync (moved)"],
		],
	);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
});

test("undoing an accepted invitation emits the removal, and undoing a removal emits the restored event", async (t) => {
	const { env, deliveries, db } = await setup(t);
	const ctx = { ...ctxFor(), grants: ["calendar.read", "calendar.write"] };
	const created = await runCalendarAction(env, ctx, "createEvent", {
		op: "execute",
		actionId: "aact_one",
		input: { variant: "", payload: invite(), reviewerUserId: "owner", messageId: "msg-1" },
	});
	const eventId = created.result.eventId;
	const undoBase = { variant: "", suggestionId: null, mailboxId: "mailbox-a", actingUserId: "owner" };
	const stored = db.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(eventId);
	await runCalendarAction(env, ctx, "createEvent", {
		op: "undo",
		actionId: "aact_one",
		inverse: { ...undoBase, inverse: { eventId }, result: { eventId } },
	});
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
	const row = {
		...stored,
		userId: stored.user_id,
		startsAt: new Date(stored.starts_at * 1000),
		endsAt: new Date(stored.ends_at * 1000),
	};
	await runCalendarAction(env, ctx, "deleteEvent", {
		op: "undo",
		actionId: "aact_two",
		inverse: {
			...undoBase,
			inverse: serializeEventRow({ ...row, createdAt: new Date(), updatedAt: new Date(), repeatUntil: null }),
			result: { eventId },
		},
	});
	assert.deepEqual(
		deliveries().map((delivery) => delivery.event_type),
		["calendar.event.created", "calendar.event.deleted", "calendar.event.created"],
	);
});

test("a repeated invite action with the same id does not emit twice", async (t) => {
	const { env, deliveries } = await setup(t);
	const ctx = { ...ctxFor(), grants: ["calendar.read", "calendar.write"] };
	const call = {
		op: "execute",
		actionId: "aact_fixed",
		input: { variant: "", payload: invite(), reviewerUserId: "owner", messageId: "msg-1" },
	};
	await runCalendarAction(env, ctx, "createEvent", call);
	await runCalendarAction(env, ctx, "createEvent", call);
	assert.equal(deliveries().length, 1);
});

const bookingEvent = (overrides = {}) => ({
	id: "type-1",
	userId: "owner",
	name: "Intro",
	slug: "intro",
	description: "",
	color: "#2563eb",
	hostIds: ["member", "owner"],
	durationMinutes: 30,
	location: "Video",
	weekdays: [1, 2, 3, 4, 5],
	startTime: "09:00",
	endTime: "17:00",
	timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
	timeZone: "Europe/Amsterdam",
	enabled: true,
	...overrides,
});

const START = "2030-04-01T09:00:00.000Z";
const END = "2030-04-01T09:30:00.000Z";

test("a booking links every host event in the same batch and emits one appointment event listing them", async (t) => {
	const { env, deliveries, db } = await setup(t);
	assert.equal(await createBookedCalendarEvents(env, bookingEvent(), "Ada", "ada@example.net", START, END), true);
	const events = db.db.prepare("SELECT id, user_id FROM calendar_events ORDER BY user_id").all();
	assert.equal(events.length, 2);
	const links = db.db.prepare("SELECT calendar_event_id, booking_event_id FROM booking_appointments").all();
	assert.deepEqual(links.map((row) => row.calendar_event_id).sort(), events.map((row) => row.id).sort());
	assert.deepEqual([...new Set(links.map((row) => row.booking_event_id))], ["type-1"]);
	const rows = deliveries();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event_type, BOOKING_EVENT);
	const { ref, appointment } = rows[0].body.data;
	const ownerEvent = events.find((row) => row.user_id === "owner").id;
	assert.deepEqual(ref, { kind: "booking:appointment", id: ownerEvent });
	assert.deepEqual([...appointment.eventIds].sort(), events.map((row) => row.id).sort());
	assert.equal(appointment.eventIds[0], ownerEvent);
	assert.equal(appointment.eventTypeId, "type-1");
	assert.equal(appointment.bookerName, "Ada");
	assert.equal(appointment.bookerEmail, "ada@example.net");
	assert.equal(appointment.start, START);
	assert.equal(appointment.timeZone, "Europe/Amsterdam");
});

test("a booking that loses the slot writes no rows and emits nothing", async (t) => {
	const { env, deliveries, db } = await setup(t);
	assert.equal(await createBookedCalendarEvents(env, bookingEvent(), "Ada", "ada@example.net", START, END), true);
	assert.equal(await createBookedCalendarEvents(env, bookingEvent(), "Bo", "bo@example.net", START, END), false);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM booking_appointments").get().n, 2);
	assert.equal(deliveries().length, 1);
});

test("a booking still succeeds, with a warning, when the appointments table is missing", async (t) => {
	const { env, deliveries, db } = await setup(t);
	db.db.exec("DROP TABLE booking_appointments");
	const warn = mock.method(console, "warn", () => undefined);
	t.after(() => warn.mock.restore());
	assert.equal(await createBookedCalendarEvents(env, bookingEvent(), "Ada", "ada@example.net", START, END), true);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 2);
	assert.match(
		warn.mock.calls.map((call) => String(call.arguments[0])).join("\n"),
		/booking\.appointments_table_missing/,
	);
	assert.equal(deliveries().length, 1);
});

test("a booking emits nothing while Booking is off", async (t) => {
	const { env, deliveries } = await setup(t);
	await setModuleEnabled(env, { moduleId: "booking", enabled: false, updatedBy: null });
	assert.equal(await createBookedCalendarEvents(env, bookingEvent(), "Ada", "ada@example.net", START, END), true);
	assert.deepEqual(deliveries(), []);
});

test("the booking payload satisfies the declared schema and names the first event as the ref", () => {
	const payload = bookingAppointmentPayload({
		eventTypeId: "type-1",
		eventIds: ["evt_a", "evt_b"],
		startsAt: START,
		endsAt: END,
		timeZone: "UTC",
		bookerName: "Ada",
		bookerEmail: "ada@example.net",
	});
	assert.deepEqual(payload.ref, { kind: "booking:appointment", id: "evt_a" });
	assert.deepEqual(payload.appointment.eventIds, ["evt_a", "evt_b"]);
});

test("moduleHost.resolveRefs resolves core and module refs for the viewer and answers neutrally for the rest", async (t) => {
	const { env, db } = await setup(t);
	db.db
		.exec(`INSERT INTO calendar_events (id, user_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at)
		VALUES ('evt_own', 'owner', 'Own review', '', '', '[]', 1900000000, 1900003600, 1, 1), ('evt_other', 'member', 'Private', '', '', '[]', 1900000000, 1900003600, 1, 1)`);
	const ctx = { ...ctxFor(), grants: ["calendar.read", "booking.read"] };
	const resolved = await moduleHost.resolveRefs(ctx, [
		{ kind: "calendar:event", id: "evt_own" },
		{ kind: "calendar:event", id: "evt_other" },
		{ kind: "user:user", id: "owner" },
	]);
	const byId = new Map(resolved.map((ref) => [ref.id, ref]));
	assert.equal(byId.get("evt_own").label, "Own review");
	assert.match(byId.get("evt_own").href, /^\//);
	assert.equal(byId.get("evt_other").unavailable, true);
	assert.equal(byId.get("evt_other").label.includes("Private"), false);
	assert.equal(byId.get("owner").unavailable, undefined);
	await setModuleEnabled(env, { moduleId: "calendar", enabled: false, updatedBy: null });
	const off = await moduleHost.resolveRefs(ctx, [{ kind: "calendar:event", id: "evt_own" }]);
	assert.equal(off[0].unavailable, true);
});
