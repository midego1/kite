import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	MODULE_MANIFESTS,
	MODULE_CAPABILITIES,
	calendarSchemas,
	bookingSchemas,
	createInvoker,
	effectiveModules,
	lifecycleTargets,
	createLifecycleEmitter,
	calendarSearchMatch,
	calendarSearchSublabel,
	searchCalendarEvents,
	freezeLegacySeriesTimeZone,
	parseSearchLimit,
	assembleSearchSections,
	flattenSections,
	nextActiveIndex,
	searchItemKey,
} = await bundleModules("kite-module-search-lifecycle-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
	["calendarSchemas", "src/lib/modules/calendar/schemas.ts"],
	["bookingSchemas", "src/lib/modules/booking/schemas.ts"],
	["createInvoker", "src/lib/modules/invoke-utils.ts"],
	["effectiveModules", "src/lib/modules/state-utils.ts"],
	["lifecycleTargets, createLifecycleEmitter", "src/lib/modules/lifecycle-utils.ts"],
	["calendarSearchMatch, calendarSearchSublabel", "src/lib/calendar/search-utils.ts"],
	["searchCalendarEvents", "src/lib/calendar/search.ts"],
	["freezeLegacySeriesTimeZone", "src/lib/calendar/time-zone.ts"],
	["parseSearchLimit, assembleSearchSections", "src/lib/search/module-search-utils.ts"],
	["flattenSections, nextActiveIndex, searchItemKey", "src/components/mail-search/search-dropdown-utils.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import", "finance"];
const enabledWith = (off) =>
	effectiveModules(new Map(ALL.map((id) => [id, !off.includes(id)])), new Map(), MODULE_MANIFESTS);

/** A lifecycle emitter over the real invoker and descriptors, with recording handlers and a chosen module state. */
function recordingEmitter({ off = [], failing = [] } = {}) {
	const enabled = enabledWith(off);
	const calls = [];
	const logged = [];
	const schemas = { calendar: calendarSchemas, booking: bookingSchemas };
	const invoke = createInvoker({
		lookup: (moduleId, name) => {
			const descriptor = MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId)?.descriptors.find(
				(item) => item.name === name,
			);
			const entry = schemas[moduleId]?.[name];
			if (!descriptor || !entry) return null;
			return {
				descriptor,
				inputSchema: entry.input,
				outputSchema: entry.output,
				handler: async (input) => {
					calls.push(`${moduleId}.${name}`);
					if (failing.includes(`${moduleId}.${name}`)) throw new Error("hook broke");
					return { handled: true, input };
				},
			};
		},
		isEnabled: async (_viewer, moduleId) => enabled.has(moduleId),
		log: () => undefined,
	});
	const emit = createLifecycleEmitter({
		capabilities: MODULE_CAPABILITIES,
		invoke,
		log: (message, fields) => logged.push({ message, ...fields }),
	});
	return { emit, calls, logged };
}

test("lifecycleTargets picks the descriptors that declare each event", () => {
	const created = lifecycleTargets(MODULE_CAPABILITIES, "user.created");
	assert.deepEqual(
		created.map(({ moduleId, descriptor }) => `${moduleId}.${descriptor.name}`),
		["booking.userCreated"],
	);
	const changed = lifecycleTargets(MODULE_CAPABILITIES, "user.time_zone_changed");
	assert.deepEqual(
		changed.map(({ moduleId, descriptor }) => `${moduleId}.${descriptor.name}`),
		["calendar.timeZoneChanged"],
	);
	assert.equal(changed[0].descriptor.lifecycle.dataHook, true);
	assert.equal(created[0].descriptor.lifecycle.dataHook, false);
});

test("user.time_zone_changed runs the Calendar data hook even while Calendar is off", async () => {
	const { emit, calls } = recordingEmitter({ off: ["calendar"] });
	await emit({ type: "user.time_zone_changed", userId: "u1", from: "UTC", to: "Europe/Paris" });
	assert.deepEqual(calls, ["calendar.timeZoneChanged"]);
});

test("user.created runs the Booking hook only while Booking is on", async () => {
	const on = recordingEmitter();
	await on.emit({ type: "user.created", userId: "u1" });
	assert.deepEqual(on.calls, ["booking.userCreated"]);

	const off = recordingEmitter({ off: ["booking"] });
	await off.emit({ type: "user.created", userId: "u1" });
	assert.deepEqual(off.calls, []);

	const calendarOff = recordingEmitter({ off: ["calendar"] });
	await calendarOff.emit({ type: "user.created", userId: "u1" });
	assert.deepEqual(calendarOff.calls, [], "Booking is off whenever Calendar is off");
});

test("a failing hook is logged and never throws into the caller", async () => {
	const { emit, calls, logged } = recordingEmitter({ failing: ["booking.userCreated"] });
	await assert.doesNotReject(emit({ type: "user.created", userId: "u1" }));
	assert.deepEqual(calls, ["booking.userCreated"]);
	assert.equal(logged.length, 1);
	assert.equal(logged[0].message, "lifecycle.hook_failed");
	assert.equal(logged[0].moduleId, "booking");
	assert.equal(logged[0].event, "user.created");
});

test("a hook that rejects an invalid event is logged too", async () => {
	const { emit, calls, logged } = recordingEmitter();
	await assert.doesNotReject(emit({ type: "user.created", userId: "" }));
	assert.deepEqual(calls, []);
	assert.equal(logged[0].code, "invalid_input");
});

async function migrated(t, directory) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, directory ?? join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1);
	`);
	return db;
}

function addEvent(db, id, userId, fields = {}) {
	const event = {
		title: "Untitled",
		description: "",
		location: "",
		attendees: "[]",
		startsAt: 1_900_000_000,
		repeat: "none",
		timeZone: null,
		...fields,
	};
	db.db
		.prepare(
			"INSERT INTO calendar_events (id, user_id, title, description, location, attendees, repeat, time_zone, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)",
		)
		.run(
			id,
			userId,
			event.title,
			event.description,
			event.location,
			event.attendees,
			event.repeat,
			event.timeZone,
			event.startsAt,
			event.startsAt + 3600,
		);
}

const ids = (items) => items.map((item) => item.ref.id);
const search = (db, userId, query, extra = {}) =>
	searchCalendarEvents({ DB: db }, { userId, timeZone: "UTC", query, limit: 5, ...extra });

test("freezeLegacySeriesTimeZone freezes only the user's own legacy recurring series", async (t) => {
	const db = await migrated(t);
	addEvent(db, "legacy", "owner", { repeat: "weekly" });
	addEvent(db, "single", "owner");
	addEvent(db, "framed", "owner", { repeat: "daily", timeZone: "Asia/Tokyo" });
	addEvent(db, "theirs", "member", { repeat: "weekly" });
	await freezeLegacySeriesTimeZone({ DB: db }, "owner", "Europe/Paris");
	const zones = Object.fromEntries(
		db.db
			.prepare("SELECT id, time_zone FROM calendar_events")
			.all()
			.map((row) => [row.id, row.time_zone]),
	);
	assert.deepEqual(zones, { legacy: "Europe/Paris", single: null, framed: "Asia/Tokyo", theirs: null });
});

test("calendarSearchMatch uses the free text only and ignores mail operators", () => {
	assert.equal(calendarSearchMatch("from:ana has:attachment"), null);
	assert.equal(calendarSearchMatch("   "), null);
	assert.equal(calendarSearchMatch("review from:ana"), '"review"*');
	assert.equal(calendarSearchMatch('"team sync" review'), '"team sync" AND "review"*');
});

test("calendar search finds the viewer's own events by title, description, location and attendees", async (t) => {
	const db = await migrated(t);
	addEvent(db, "e-title", "owner", { title: "Zephyrquokka planning" });
	addEvent(db, "e-desc", "owner", { title: "Sync", description: "Bring the grumblethwait notes" });
	addEvent(db, "e-loc", "owner", { title: "Lunch", location: "Marmaladeville cafe" });
	addEvent(db, "e-att", "owner", { title: "Call", attendees: JSON.stringify(["wibblefrost@example.com"]) });
	assert.deepEqual(ids(await search(db, "owner", "zephyrquokka")), ["e-title"]);
	assert.deepEqual(ids(await search(db, "owner", "grumblethwait")), ["e-desc"]);
	assert.deepEqual(ids(await search(db, "owner", "marmaladeville")), ["e-loc"]);
	assert.deepEqual(ids(await search(db, "owner", "wibblefrost")), ["e-att"]);
});

test("calendar search items carry a ref, label, sublabel and a calendar link on the event's day", async (t) => {
	const db = await migrated(t);
	// 2030-04-01T23:30:00Z is 2030-04-02 in Europe/Amsterdam.
	addEvent(db, "e1", "owner", {
		title: "Zephyrquokka review",
		location: "Room 4",
		startsAt: Date.UTC(2030, 3, 1, 23, 30) / 1000,
	});
	const [utc] = await search(db, "owner", "zephyrquokka");
	assert.deepEqual(utc.ref, { kind: "calendar:event", id: "e1" });
	assert.equal(utc.label, "Zephyrquokka review");
	assert.equal(utc.href, "/calendar?date=2030-04-01&event=e1");
	assert.match(utc.sublabel, /Room 4/);
	assert.match(utc.sublabel, /11:30/);
	const [ams] = await search(db, "owner", "zephyrquokka", { timeZone: "Europe/Amsterdam" });
	assert.equal(ams.href, "/calendar?date=2030-04-02&event=e1");
});

test("another user's events never appear, whoever searches", async (t) => {
	const db = await migrated(t);
	addEvent(db, "mine", "owner", { title: "Ownerword gathering" });
	addEvent(db, "theirs", "member", { title: "Memberword gathering" });
	assert.deepEqual(ids(await search(db, "owner", "ownerword")), ["mine"]);
	assert.deepEqual(await search(db, "owner", "memberword"), []);
	assert.deepEqual(ids(await search(db, "member", "memberword")), ["theirs"]);
	assert.deepEqual(await search(db, "member", "ownerword"), []);
	assert.deepEqual(ids(await search(db, "owner", "gathering")), ["mine"]);
});

test("the index follows insert, rename and delete", async (t) => {
	const db = await migrated(t);
	addEvent(db, "e1", "owner", { title: "alphaword" });
	assert.deepEqual(ids(await search(db, "owner", "alphaword")), ["e1"]);
	db.db.prepare("UPDATE calendar_events SET title = 'betaword' WHERE id = 'e1'").run();
	assert.deepEqual(await search(db, "owner", "alphaword"), []);
	assert.deepEqual(ids(await search(db, "owner", "betaword")), ["e1"]);
	db.db.prepare("DELETE FROM calendar_events WHERE id = 'e1'").run();
	assert.deepEqual(await search(db, "owner", "alphaword"), []);
	assert.deepEqual(await search(db, "owner", "betaword"), []);
});

test("calendar search honours the limit, prefers events near now and survives hostile text", async (t) => {
	const db = await migrated(t);
	const now = 1_900_000_000;
	addEvent(db, "far", "owner", { title: "Standup far", startsAt: now + 400 * 86_400 });
	addEvent(db, "near", "owner", { title: "Standup near", startsAt: now + 3_600 });
	addEvent(db, "past", "owner", { title: "Standup past", startsAt: now - 30 * 86_400 });
	assert.deepEqual(ids(await search(db, "owner", "standup", { now: new Date(now * 1000) })), ["near", "past", "far"]);
	assert.deepEqual(ids(await search(db, "owner", "standup", { limit: 1, now: new Date(now * 1000) })), ["near"]);
	for (const hostile of ['"', "a OR b", "title:(", "NEAR(", "*", "-", "' OR 1=1 --"])
		await assert.doesNotReject(search(db, "owner", hostile), hostile);
	assert.deepEqual(await search(db, "owner", "from:ana"), []);
});

test("a database from before migration 0062 answers with no items instead of failing", async (t) => {
	const scratch = makeBundleDirectory("kite-module-search-pre-");
	t.after(async () => (await import("node:fs")).rmSync(scratch, { recursive: true, force: true }));
	const db = await migrated(t, copyMigrationsBefore(scratch, 62));
	addEvent(db, "e1", "owner", { title: "Zephyrquokka" });
	assert.deepEqual(await search(db, "owner", "zephyrquokka"), []);
});

test("parseSearchLimit defaults to 5 and stays within 1 to 20", () => {
	assert.equal(parseSearchLimit(null), 5);
	assert.equal(parseSearchLimit(""), 5);
	assert.equal(parseSearchLimit("abc"), 5);
	assert.equal(parseSearchLimit("0"), 1);
	assert.equal(parseSearchLimit("3"), 3);
	assert.equal(parseSearchLimit("3.9"), 3);
	assert.equal(parseSearchLimit("500"), 20);
});

test("calendarSearchSublabel joins the start time and the location", () => {
	const at = new Date(Date.UTC(2030, 3, 1, 9, 0));
	assert.match(calendarSearchSublabel(at, "UTC", ""), /9:00/);
	assert.doesNotMatch(calendarSearchSublabel(at, "UTC", ""), /·/);
	assert.match(calendarSearchSublabel(at, "UTC", "Room 4"), /· Room 4$/);
});

test("assembleSearchSections labels sections from manifests and drops items that are not safe links of the module's kinds", () => {
	const good = { ref: { kind: "calendar:event", id: "e1" }, label: "A", sublabel: "s", href: "/calendar?event=e1" };
	const results = [
		{
			moduleId: "calendar",
			section: "events",
			items: [
				good,
				{ ...good, ref: { kind: "calendar:event", id: "e2" }, href: "//evil.example" },
				{ ...good, ref: { kind: "calendar:event", id: "e3" }, href: "https://evil.example" },
				{ ...good, ref: { kind: "booking:event_type", id: "e4" } },
			],
		},
		{ moduleId: "calendar", section: "unknown_section", items: [good] },
		{ moduleId: "booking", section: "events", items: [good] },
	];
	assert.deepEqual(assembleSearchSections(MODULE_MANIFESTS, results, 5), [
		{ id: "events", label: "Events", items: [good] },
	]);
	assert.deepEqual(
		assembleSearchSections(MODULE_MANIFESTS, [{ moduleId: "calendar", section: "events", items: [] }], 5),
		[],
	);
	assert.deepEqual(assembleSearchSections(MODULE_MANIFESTS, [], 5), []);
	const many = Array.from({ length: 8 }, (_, index) => ({ ...good, ref: { kind: "calendar:event", id: `m${index}` } }));
	assert.equal(
		assembleSearchSections(MODULE_MANIFESTS, [{ moduleId: "calendar", section: "events", items: many }], 3)[0].items
			.length,
		3,
	);
});

test("the dropdown walks items across sections with arrow keys and stops at the ends", () => {
	const item = (id) => ({ ref: { kind: "calendar:event", id }, label: id, sublabel: "", href: "/calendar" });
	const sections = [
		{ id: "events", label: "Events", items: [item("a"), item("b")] },
		{ id: "more", label: "More", items: [item("c")] },
	];
	const flat = flattenSections(sections);
	assert.deepEqual(flat.map(searchItemKey), ["calendar:event:a", "calendar:event:b", "calendar:event:c"]);
	assert.equal(nextActiveIndex(-1, 3, "ArrowDown"), 0);
	assert.equal(nextActiveIndex(2, 3, "ArrowDown"), 2);
	assert.equal(nextActiveIndex(0, 3, "ArrowUp"), -1);
	assert.equal(nextActiveIndex(-1, 3, "ArrowUp"), -1);
	assert.equal(nextActiveIndex(1, 0, "ArrowDown"), -1);
});
