import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-calendar-reminders-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		utils: join(root, "src/lib/calendar/reminder-utils.ts"),
		invoke: join(root, "src/lib/modules/invoke.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
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
const { REMINDER_KEY_PATTERN, reminderTimes } = await load("utils");
const { invokeCapability } = await load("invoke");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const HOOK_URL = "https://hooks.kite-validation.invalid/calendar";
const KEY = "finance-renewal:fsub_abc";
const realFetch = globalThis.fetch;

const ctxFor = (userId, grants = ["calendar.write"]) => ({
	viewer: { userId, role: "user", isPrimaryAdmin: false },
	requestId: "req-1",
	locale: "en",
	timeZone: "UTC",
	grants,
	trigger: "cron",
});

function reminder(overrides = {}) {
	return {
		userId: "owner",
		key: KEY,
		title: "Streamflix renews ($17.99)",
		description: "Open in Money Watch: /finance?subscription=fsub_abc",
		date: "2026-11-01",
		time: "09:00",
		durationMinutes: 15,
		timeZone: "Europe/Amsterdam",
		sourceMessageId: null,
		...overrides,
	};
}

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'Europe/Amsterdam', 1),
			('other', 'other@example.com', 'hash', 'Other', 'UTC', 1);
	`);
	const addHook = db.db.prepare(
		"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES (?, ?, ?, 'whsec_test', ?, 1, 3, 1)",
	);
	const events = JSON.stringify(["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"]);
	addHook.run("wh-owner", "owner", HOOK_URL, events);
	addHook.run("wh-other", "other", HOOK_URL, events);
	globalThis.__kiteNodeEnv = { DB: db, OUTBOUND_QUEUE: { send: async () => undefined } };
	globalThis.fetch = async () => new Response("ok", { status: 200 });
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		globalThis.fetch = realFetch;
		clearModuleStateCache();
	});
	const events_ = () => db.db.prepare("SELECT * FROM calendar_events ORDER BY created_at, rowid").all();
	const deliveries = () =>
		db.db
			.prepare("SELECT webhook_id, event_type FROM webhook_deliveries ORDER BY created_at, rowid")
			.all()
			.map((row) => `${row.webhook_id}:${row.event_type}`);
	return { db, events: events_, deliveries };
}

const upsert = (input, ctx = ctxFor("owner")) => invokeCapability("calendar", "upsertReminder", input, ctx);
const remove = (input, ctx = ctxFor("owner")) => invokeCapability("calendar", "removeReminder", input, ctx);

test("the reminder key names a module record and can never be an invitation UID", () => {
	for (const key of ["finance-renewal:fsub_abc", "a:1", `x:${"a".repeat(100)}`])
		assert.match(key, REMINDER_KEY_PATTERN);
	for (const key of [
		"Finance:abc",
		"finance-renewal:",
		"finance-renewal:a@mailflare",
		"finance renewal:abc",
		"1finance:abc",
		`x:${"a".repeat(101)}`,
		"finance-renewal:a/b",
	])
		assert.doesNotMatch(key, REMINDER_KEY_PATTERN, key);
});

test("the reminder starts at the wall-clock time in its zone on both sides of a DST change", () => {
	const summer = reminderTimes("2026-03-30", "09:00", 15, "Europe/Amsterdam");
	assert.equal(summer.startsAt.toISOString(), "2026-03-30T07:00:00.000Z");
	assert.equal(summer.endsAt.toISOString(), "2026-03-30T07:15:00.000Z");
	const winter = reminderTimes("2026-03-28", "09:00", 15, "Europe/Amsterdam");
	assert.equal(winter.startsAt.toISOString(), "2026-03-28T08:00:00.000Z");
	const fallBack = reminderTimes("2026-11-02", "09:00", 30, "America/New_York");
	assert.equal(fallBack.startsAt.toISOString(), "2026-11-02T14:00:00.000Z");
	assert.equal(fallBack.endsAt.toISOString(), "2026-11-02T14:30:00.000Z");
	assert.equal(reminderTimes("2026-11-02", "09:00", 15, "UTC").startsAt.toISOString(), "2026-11-02T09:00:00.000Z");
});

test("upsertReminder inserts once, updates on a changed call and never duplicates", async (t) => {
	const { events, deliveries } = await setup(t);
	const first = await upsert(reminder());
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(first.output.created, true);
	assert.deepEqual(first.output.ref, { kind: "calendar:event", id: first.output.eventId });
	const [event] = events();
	assert.equal(event.id, first.output.eventId);
	assert.equal(event.user_id, "owner");
	assert.equal(event.ical_uid, KEY);
	assert.equal(event.title, "Streamflix renews ($17.99)");
	assert.match(event.description, /\/finance\?subscription=fsub_abc/);
	assert.equal(event.time_zone, "Europe/Amsterdam");
	assert.equal(event.starts_at, Date.parse("2026-11-01T08:00:00.000Z") / 1000);
	assert.equal(event.ends_at, Date.parse("2026-11-01T08:15:00.000Z") / 1000);

	const repeated = await Promise.all([upsert(reminder()), upsert(reminder()), upsert(reminder())]);
	assert.ok(repeated.every((result) => result.ok && result.output.created === false));
	assert.ok(repeated.every((result) => result.output.eventId === first.output.eventId));
	assert.equal(events().length, 1, "repeated calls never insert a second event");
	assert.deepEqual(deliveries(), ["wh-owner:calendar.event.created"], "an unchanged repeat writes nothing");

	const moved = await upsert(reminder({ date: "2026-12-01", title: "Streamflix renews ($19.99)" }));
	assert.equal(moved.output.created, false);
	assert.equal(moved.output.eventId, first.output.eventId);
	const [updated] = events();
	assert.equal(events().length, 1);
	assert.equal(updated.title, "Streamflix renews ($19.99)");
	assert.equal(updated.starts_at, Date.parse("2026-12-01T08:00:00.000Z") / 1000);
	assert.deepEqual(deliveries(), ["wh-owner:calendar.event.created", "wh-owner:calendar.event.updated"]);
});

test("a source message is kept only when it is the user's own", async (t) => {
	const { db, events } = await setup(t);
	db.db.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'owner', 'personal', 1),
			('mailbox-b', 'other', 'domain-1', 'other', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
			('msg-own', 'owner', 'mailbox-a', 'inbound', 'a@vendor.test', 'owner@example.com', 'Invoice', 'received', 1),
			('msg-other', 'other', 'mailbox-b', 'inbound', 'a@vendor.test', 'other@example.com', 'Invoice', 'received', 1);
	`);
	await upsert(reminder({ sourceMessageId: "msg-own" }));
	assert.equal(events()[0].source_message_id, "msg-own");
	await upsert(reminder({ key: "finance-renewal:fsub_two", sourceMessageId: "msg-other" }));
	assert.equal(events()[1].source_message_id, null);
});

test("the key is validated and a caller can only write the calendar of the user it acts for", async (t) => {
	const { events } = await setup(t);
	for (const key of ["finance-renewal:a@mailflare", "Finance:abc", "finance-renewal:"]) {
		const result = await upsert(reminder({ key }));
		assert.equal(result.ok, false, key);
		assert.equal(result.error.code, "invalid_input");
	}
	assert.equal((await upsert(reminder({ durationMinutes: 4 }))).error.code, "invalid_input");
	assert.equal((await upsert(reminder({ durationMinutes: 121 }))).error.code, "invalid_input");
	assert.equal((await upsert(reminder({ time: "24:00" }))).error.code, "invalid_input");
	assert.equal((await upsert(reminder({ date: "2026-02-30" }))).error.code, "invalid_input");
	assert.equal((await upsert(reminder({ timeZone: "Mars/Olympus" }))).error.code, "invalid_input");
	assert.equal((await upsert(reminder({ title: "x".repeat(121) }))).error.code, "invalid_input");

	const forged = await upsert(reminder({ userId: "other" }));
	assert.deepEqual(forged.ok && forged.output, { refused: "forbidden" });
	const noViewer = await upsert(reminder(), { ...ctxFor("owner"), viewer: null });
	assert.deepEqual(noViewer.ok && noViewer.output, { refused: "forbidden" });
	assert.equal((await remove({ userId: "other", key: KEY })).output.refused, "forbidden");
	const noGrant = await upsert(reminder(), ctxFor("owner", []));
	assert.equal(noGrant.error.code, "forbidden");
	assert.deepEqual(events(), []);
});

test("removeReminder deletes the user's event for the key and says whether it did", async (t) => {
	const { events, deliveries } = await setup(t);
	await upsert(reminder());
	await upsert(reminder({ userId: "other" }), ctxFor("other"));
	assert.equal(events().length, 2);
	assert.deepEqual(await remove({ userId: "owner", key: KEY }).then((result) => result.output), { removed: true });
	assert.deepEqual(
		events().map((event) => event.user_id),
		["other"],
		"another user's event with the same key stays",
	);
	assert.deepEqual(await remove({ userId: "owner", key: KEY }).then((result) => result.output), { removed: false });
	assert.deepEqual(deliveries(), [
		"wh-owner:calendar.event.created",
		"wh-other:calendar.event.created",
		"wh-owner:calendar.event.deleted",
	]);
});

test("with Calendar off for the user the services answer module_disabled", async (t) => {
	const { db, events } = await setup(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('uma-1', 'owner', 'calendar', 0, 1)",
	);
	clearModuleStateCache();
	assert.equal((await upsert(reminder())).error.code, "module_disabled");
	assert.equal((await remove({ userId: "owner", key: KEY })).error.code, "module_disabled");
	assert.deepEqual(events(), []);
});
