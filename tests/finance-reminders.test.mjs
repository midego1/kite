import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { loadFinance } from "./support/finance-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const utils = await loadFinance("reminder-utils");
const { dueOf, reminderStep, reminderNotice, reminderEvent, renewalDuePayload, calendarSync, selectionBounds } = utils;
const { dayInTimeZone } = await loadFinance("date-utils");

const outDir = makeBundleDirectory("kite-finance-reminders-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Splitting keeps one copy of the host bindings and the module state cache across the entries.
await build({
	entryPoints: {
		invoke: join(root, "src/lib/modules/invoke.ts"),
		execute: join(root, "src/lib/agent/auto-read/execute.ts"),
		manual: join(root, "src/lib/finance/manual.ts"),
		store: join(root, "src/lib/finance/reminder-store.ts"),
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
const { invokeCapability } = await load("invoke");
const { undoAgentAction } = await load("execute");
const { addSubscription, changeSubscription, removeSubscription } = await load("manual");
const { claimReminder, dueRows } = await load("store");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const DAY_MS = 86_400_000;
const at = (day) => (day ? new Date(`${day}T00:00:00.000Z`) : null);
const HOOK_URL = "https://hooks.kite-validation.invalid/finance";
const VENDOR = "Acmeflix";

function row(extra = {}) {
	return {
		id: "fsub_1",
		userId: "owner",
		vendor: VENDOR,
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		plan: null,
		status: "active",
		nextRenewalAt: null,
		trialEndsAt: null,
		reminderDays: 3,
		calendarReminder: true,
		lastRemindedFor: null,
		calendarEventId: null,
		sourceMessageId: null,
		...extra,
	};
}

// --- Pure rules ---------------------------------------------------------------------------------

test("the due date is the trial end for a trial that has one, otherwise the renewal", () => {
	assert.deepEqual(dueOf(row({ nextRenewalAt: at("2026-11-01") })), {
		on: "2026-11-01",
		at: at("2026-11-01"),
		kind: "renewal",
	});
	const trial = row({ status: "trial", trialEndsAt: at("2026-10-20"), nextRenewalAt: at("2026-11-01") });
	assert.deepEqual(dueOf(trial), { on: "2026-10-20", at: at("2026-10-20"), kind: "trial_end" });
	assert.equal(dueOf(row({ status: "trial", nextRenewalAt: at("2026-11-01") })).kind, "renewal");
	assert.equal(dueOf(row({ trialEndsAt: at("2026-10-20"), nextRenewalAt: at("2026-11-01") })).on, "2026-11-01");
	assert.equal(dueOf(row()), null);
});

test("a row is reminded inside its window, waits before it and is claimed silently once missed", () => {
	const today = "2026-10-14";
	const due = (day, extra = {}) => reminderStep(row({ nextRenewalAt: at(day), ...extra }), today);
	assert.equal(due("2026-10-16").step, "remind");
	assert.equal(due("2026-10-16").daysLeft, 2);
	assert.equal(due("2026-10-17").daysLeft, 3);
	assert.equal(due("2026-10-14").daysLeft, 0);
	assert.equal(due("2026-10-18").step, "wait", "four days out with three reminder days");
	assert.equal(due("2026-10-24").step, "wait", "ten days out");
	assert.equal(due("2026-10-13").step, "silent", "a due date that passed unannounced");
	assert.equal(due("2026-10-16", { reminderDays: 0 }).step, "wait");
	assert.equal(due("2026-10-16", { status: "cancelled" }).step, "wait");
	assert.equal(due("2026-10-16", { status: "expired" }).step, "wait");
	assert.equal(due("2026-10-16", { lastRemindedFor: at("2026-10-16") }).step, "wait", "already reminded");
	assert.equal(due("2026-10-16", { lastRemindedFor: at("2026-09-16") }).step, "remind", "re-armed by a new date");
	assert.equal(reminderStep(row(), today).step, "wait");
	assert.equal(due("2026-11-13", { reminderDays: 30 }).step, "remind");
});

test("the window follows the owner's calendar day across DST changes", () => {
	const amsterdam = (iso) =>
		reminderStep(row({ nextRenewalAt: at("2026-04-01") }), dayInTimeZone(iso, "Europe/Amsterdam"));
	// 23:30 UTC on 28 March is already 29 March in Amsterdam, the night the clocks go forward.
	assert.equal(amsterdam("2026-03-28T23:30:00.000Z").daysLeft, 3);
	assert.equal(amsterdam("2026-03-28T22:30:00.000Z").step, "wait");
	const newYork = (iso) =>
		reminderStep(row({ nextRenewalAt: at("2026-11-03"), reminderDays: 2 }), dayInTimeZone(iso, "America/New_York"));
	// 04:30 UTC on 1 November is 00:30 EDT; the clocks go back at 06:00 UTC.
	assert.equal(newYork("2026-11-01T03:30:00.000Z").step, "wait");
	assert.equal(newYork("2026-11-01T04:30:00.000Z").daysLeft, 2);
	assert.equal(newYork("2026-11-02T04:30:00.000Z").daysLeft, 2, "still 1 November at 23:30 EST");
	assert.equal(newYork("2026-11-02T05:30:00.000Z").daysLeft, 1);
});

test("the notice, the calendar event and the webhook payload say when and how much", () => {
	const renewal = row({ nextRenewalAt: at("2026-10-16") });
	const due = dueOf(renewal);
	assert.deepEqual(reminderNotice(renewal, due, 2, "en"), {
		notice: "renewal_due",
		title: "Acmeflix renews in 2 days ($17.99)",
		href: "/finance?subscription=fsub_1",
	});
	assert.equal(reminderNotice(renewal, due, 1, "en").title, "Acmeflix renews tomorrow ($17.99)");
	assert.equal(reminderNotice(renewal, due, 0, "en").title, "Acmeflix renews today ($17.99)");
	assert.equal(reminderNotice(row({ ...renewal, amountMinor: null }), due, 3, "en").title, "Acmeflix renews in 3 days");
	const trial = row({ status: "trial", trialEndsAt: at("2026-10-15") });
	assert.equal(reminderNotice(trial, dueOf(trial), 1, "en").title, "Your Acmeflix trial ends tomorrow");
	assert.equal(reminderNotice(trial, dueOf(trial), 3, "en").title, "Your Acmeflix trial ends in 3 days");

	assert.deepEqual(reminderEvent(renewal, due, "Europe/Amsterdam"), {
		key: "finance-renewal:fsub_1",
		title: "Acmeflix renews ($17.99)",
		description: "Open in Money Watch: /finance?subscription=fsub_1",
		date: "2026-10-16",
		time: "09:00",
		durationMinutes: 15,
		timeZone: "Europe/Amsterdam",
		sourceMessageId: null,
	});
	assert.equal(reminderEvent(trial, dueOf(trial), "UTC").title, "Acmeflix trial ends");
	assert.equal(reminderEvent(row({ ...renewal, amountMinor: null }), due, "UTC").title, "Acmeflix renews");

	assert.deepEqual(renewalDuePayload(renewal, due, 2), {
		subscription: {
			ref: { kind: "finance:subscription", id: "fsub_1" },
			vendor: VENDOR,
			plan: null,
			amount: { minor: 1799, currency: "USD" },
			cycle: "monthly",
			status: "active",
			nextRenewalOn: "2026-10-16",
			trialEndsOn: null,
		},
		due: { on: "2026-10-16", kind: "renewal", daysLeft: 2 },
	});
});

test("the calendar event is removed when it can no longer apply and kept in step otherwise", () => {
	const due = at("2026-10-16");
	const fired = row({ nextRenewalAt: due, lastRemindedFor: due });
	assert.equal(calendarSync(null), "remove");
	assert.equal(calendarSync(fired), "upsert", "the reminder fired for this date");
	assert.equal(
		calendarSync(row({ nextRenewalAt: at("2026-11-16"), lastRemindedFor: due, calendarEventId: "evt_1" })),
		"upsert",
	);
	const moved = row({ nextRenewalAt: at("2026-11-16"), lastRemindedFor: due });
	assert.equal(calendarSync(moved), "none", "a change leaves an unclaimed new date to the cron");
	assert.equal(calendarSync(moved, { restore: true }), "upsert", "an undo puts back the event the row had");
	assert.equal(calendarSync(row({ nextRenewalAt: due })), "none", "the cron adds it when the window opens");
	assert.equal(calendarSync({ ...moved, calendarReminder: false }, { restore: true }), "remove");
	assert.equal(calendarSync({ ...fired, calendarReminder: false }), "remove");
	assert.equal(calendarSync({ ...fired, reminderDays: 0 }), "remove");
	assert.equal(calendarSync({ ...fired, status: "cancelled" }), "remove");
	assert.equal(calendarSync({ ...fired, status: "expired" }), "remove");
	assert.equal(calendarSync({ ...fired, nextRenewalAt: null }), "remove");
});

test("the query bounds cover the whole owner-local due day in every time zone", () => {
	const { from, until } = selectionBounds(new Date("2026-10-14T12:00:00.000Z"));
	// A date stored at 00:00 UTC is still today at UTC-12 until 36 hours later.
	assert.equal(from.toISOString(), "2026-10-12T12:00:00.000Z");
	assert.equal(until.toISOString(), "2026-10-15T12:00:00.000Z");
});

// --- The cron task against a database ----------------------------------------------------------

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});

const cronCtx = {
	viewer: null,
	requestId: "cron-1",
	locale: "en",
	timeZone: "UTC",
	grants: ["finance.read", "finance.write"],
	trigger: "cron",
};

async function setup(t, { timeZone = "UTC" } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db
		.prepare(
			`INSERT INTO users (id, email, password_hash, name, time_zone, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', ?, 1),
			('other', 'other@example.com', 'hash', 'Other', 'UTC', 1)`,
		)
		.run(timeZone);
	db.db.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'owner', 'personal', 1);
	`);
	const addHook = db.db.prepare(
		"INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES (?, ?, ?, 'whsec_test', ?, 1, 3, 1)",
	);
	addHook.run("wh-owner", "owner", HOOK_URL, JSON.stringify(["finance.subscription.renewal_due"]));
	addHook.run("wh-other", "other", HOOK_URL, JSON.stringify(["finance.subscription.renewal_due"]));
	const frames = [];
	const noticeHooks = [];
	const failNotifyFor = new Set();
	const env = {
		DB: db,
		OUTBOUND_QUEUE: { send: async () => undefined },
		REALTIME: {
			getByName(userId) {
				if (failNotifyFor.has(userId)) throw new Error("hub unavailable");
				return {
					fetch: async (_url, init) => {
						const frame = { userId, ...JSON.parse(init.body) };
						frames.push(frame);
						if (frame.type === "module_notice") await noticeHooks.shift()?.(frame);
						return new Response("ok");
					},
				};
			},
		},
	};
	globalThis.__kiteNodeEnv = env;
	globalThis.fetch = async () => new Response("ok", { status: 200 });
	clearModuleStateCache();
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (line) => warnings.push(String(line));
	t.after(() => {
		console.warn = realWarn;
		delete globalThis.__kiteNodeEnv;
		globalThis.fetch = realFetch;
		clearModuleStateCache();
	});
	let order = 0;
	const insert = db.db.prepare(
		`INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, amount_minor, currency, cycle, next_renewal_at, trial_ends_at, status, reminder_days, calendar_reminder, last_reminded_for, created_at, updated_at)
		VALUES (@id, @userId, 'mailbox-a', @vendor, 'acmeflix.example', @amountMinor, 'USD', 'monthly', @next, @trial, @status, @reminderDays, @calendarReminder, @reminded, @order, @order)`,
	);
	const seconds = (day) => (day ? Date.parse(`${day}T00:00:00.000Z`) / 1000 : null);
	const addRow = (id, values = {}) => {
		order += 1;
		insert.run({
			id,
			userId: "owner",
			vendor: VENDOR,
			amountMinor: 1799,
			status: "active",
			reminderDays: 3,
			calendarReminder: 1,
			order,
			...values,
			next: seconds(values.next ?? null),
			trial: seconds(values.trial ?? null),
			reminded: seconds(values.reminded ?? null),
		});
	};
	const restrict = (userId, moduleId) => {
		db.db
			.prepare(
				"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES (?, ?, ?, 0, 1) ON CONFLICT (user_id, module_id) DO UPDATE SET allowed = 0",
			)
			.run(`uma-${userId}-${moduleId}`, userId, moduleId);
		clearModuleStateCache();
	};
	const allow = (userId, moduleId) => {
		db.db.prepare("DELETE FROM user_module_access WHERE user_id = ? AND module_id = ?").run(userId, moduleId);
		clearModuleStateCache();
	};
	const subscription = (id) => db.db.prepare("SELECT * FROM finance_subscriptions WHERE id = ?").get(id);
	const events = () => db.db.prepare("SELECT * FROM calendar_events ORDER BY created_at, rowid").all();
	const audits = () =>
		db.db.prepare("SELECT action, actor_user_id, metadata FROM audit_logs WHERE action LIKE 'finance.%'").all();
	const deliveries = () =>
		db.db
			.prepare("SELECT webhook_id, event_type, payload FROM webhook_deliveries ORDER BY created_at, rowid")
			.all()
			.map((delivery) => ({
				webhookId: delivery.webhook_id,
				event: delivery.event_type,
				body: JSON.parse(delivery.payload),
			}));
	const notices = () => frames.filter((frame) => frame.type === "module_notice");
	/** Runs `hook` inside the next notice, while the tick that sent it still holds its selected rows. */
	const duringNextNotice = (hook) => noticeHooks.push(hook);
	return {
		duringNextNotice,
		db,
		env,
		addRow,
		restrict,
		allow,
		subscription,
		events,
		audits,
		deliveries,
		notices,
		frames,
		failNotifyFor,
		warnings,
	};
}

const tick = (scheduledTime) => invokeCapability("finance", "remindRenewals", { scheduledTime }, cronCtx);
const NOW = "2026-10-14T12:00:00.000Z";

test("one tick reminds a row inside its window once: notice, owner webhook, calendar event and audit", async (t) => {
	const context = await setup(t, { timeZone: "Europe/Amsterdam" });
	context.addRow("fsub_soon", { next: "2026-10-16" });
	const first = await tick(NOW);
	assert.deepEqual(first, { ok: true, output: { reminded: 1 } });
	assert.deepEqual(context.notices(), [
		{
			userId: "owner",
			type: "module_notice",
			moduleId: "finance",
			notice: "renewal_due",
			title: "Acmeflix renews in 2 days ($17.99)",
			body: null,
			href: "/finance?subscription=fsub_soon",
		},
	]);
	const stored = context.subscription("fsub_soon");
	assert.equal(stored.last_reminded_for, Date.parse("2026-10-16T00:00:00.000Z") / 1000);
	const [event] = context.events();
	assert.equal(context.events().length, 1);
	assert.equal(event.user_id, "owner");
	assert.equal(event.ical_uid, "finance-renewal:fsub_soon");
	assert.equal(event.title, "Acmeflix renews ($17.99)");
	assert.equal(event.starts_at, Date.parse("2026-10-16T07:00:00.000Z") / 1000, "09:00 in Amsterdam");
	assert.equal(event.ends_at - event.starts_at, 15 * 60);
	assert.match(event.description, /\/finance\?subscription=fsub_soon/);
	assert.equal(stored.calendar_event_id, event.id);
	const [audit] = context.audits();
	assert.equal(audit.actor_user_id, "owner");
	assert.deepEqual(JSON.parse(audit.metadata), { subscriptionId: "fsub_soon", eventId: event.id, created: true });

	const due = context.deliveries().filter((delivery) => delivery.event === "finance.subscription.renewal_due");
	assert.deepEqual(
		due.map((delivery) => delivery.webhookId),
		["wh-owner"],
		"only the owner's webhook",
	);
	assert.deepEqual(due[0].body.data.due, { on: "2026-10-16", kind: "renewal", daysLeft: 2 });
	assert.equal(due[0].body.data.subscription.ref.id, "fsub_soon");

	const second = await tick("2026-10-14T12:05:00.000Z");
	assert.deepEqual(second.output, { reminded: 0 });
	assert.equal(context.notices().length, 1, "no second notice");
	assert.equal(context.events().length, 1, "no second event");
	assert.equal(
		context.deliveries().filter((delivery) => delivery.event === "finance.subscription.renewal_due").length,
		1,
	);

	const overlapping = await Promise.all([tick(NOW), tick(NOW)]);
	assert.ok(overlapping.every((result) => result.output.reminded === 0));
});

test("rows outside the window, turned off or not active are left alone", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_far", { next: "2026-10-24" });
	context.addRow("fsub_off", { next: "2026-10-16", reminderDays: 0 });
	context.addRow("fsub_cancelled", { next: "2026-10-16", status: "cancelled" });
	context.addRow("fsub_expired", { next: "2026-10-16", status: "expired" });
	context.addRow("fsub_trial", { status: "trial", trial: "2026-10-15", next: "2026-11-15" });
	const result = await tick(NOW);
	assert.deepEqual(result.output, { reminded: 1 });
	assert.deepEqual(
		context.notices().map((notice) => notice.title),
		["Your Acmeflix trial ends tomorrow"],
	);
	for (const id of ["fsub_far", "fsub_off", "fsub_cancelled", "fsub_expired"])
		assert.equal(context.subscription(id).last_reminded_for, null, id);
	assert.equal(context.subscription("fsub_trial").last_reminded_for, Date.parse("2026-10-15T00:00:00.000Z") / 1000);
	assert.deepEqual(
		context.events().map((event) => event.title),
		["Acmeflix trial ends"],
	);
	const [delivery] = context.deliveries();
	assert.deepEqual(delivery.body.data.due, { on: "2026-10-15", kind: "trial_end", daysLeft: 1 });
});

test("a due date that passed while it was not reminded is claimed silently", async (t) => {
	// Already 15 October on Kiritimati (UTC+14) while it is 14 October in UTC.
	const context = await setup(t, { timeZone: "Pacific/Kiritimati" });
	context.addRow("fsub_missed", { next: "2026-10-14" });
	assert.deepEqual((await tick(NOW)).output, { reminded: 0 });
	assert.equal(context.subscription("fsub_missed").last_reminded_for, Date.parse("2026-10-14T00:00:00.000Z") / 1000);
	assert.deepEqual(context.notices(), []);
	assert.deepEqual(context.events(), []);
	assert.deepEqual(context.deliveries(), []);
});

test("a user restricted from Money Watch keeps their rows untouched until access returns", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_soon", { next: "2026-10-16" });
	context.restrict("owner", "finance");
	assert.deepEqual((await tick(NOW)).output, { reminded: 0 });
	assert.equal(context.subscription("fsub_soon").last_reminded_for, null);
	assert.deepEqual(context.notices(), []);
	assert.deepEqual(context.events(), []);
	context.allow("owner", "finance");
	assert.deepEqual((await tick(NOW)).output, { reminded: 1 });
	assert.equal(context.notices().length, 1);
});

test("with Calendar off for the owner, or the item's calendar reminder off, the notice comes without an event", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_soon", { next: "2026-10-16" });
	context.addRow("fsub_plain", { next: "2026-10-15", calendarReminder: 0 });
	context.restrict("owner", "calendar");
	assert.deepEqual((await tick(NOW)).output, { reminded: 2 });
	assert.equal(context.notices().length, 2);
	assert.deepEqual(context.events(), []);
	assert.equal(context.subscription("fsub_soon").calendar_event_id, null);
	assert.equal(context.deliveries().length, 2);
});

test("a new due date re-arms the reminder and moves the same calendar event", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_soon", { next: "2026-10-16" });
	await tick(NOW);
	const [event] = context.events();
	context.db.db
		.prepare("UPDATE finance_subscriptions SET next_renewal_at = ? WHERE id = 'fsub_soon'")
		.run(Date.parse("2026-11-16T00:00:00.000Z") / 1000);
	assert.deepEqual((await tick("2026-11-14T12:00:00.000Z")).output, { reminded: 1 });
	assert.equal(context.notices().length, 2);
	const events = context.events();
	assert.equal(events.length, 1);
	assert.equal(events[0].id, event.id);
	assert.equal(events[0].starts_at, Date.parse("2026-11-16T09:00:00.000Z") / 1000);
});

test("the tick time comes from scheduledTime and the window from the owner's zone across DST", async (t) => {
	const context = await setup(t, { timeZone: "Europe/Amsterdam" });
	context.addRow("fsub_spring", { next: "2026-04-01" });
	assert.deepEqual((await tick("2026-03-28T22:30:00.000Z")).output, { reminded: 0 });
	assert.deepEqual((await tick("2026-03-28T23:30:00.000Z")).output, { reminded: 1 });
	assert.equal(context.notices()[0].title, "Acmeflix renews in 3 days ($17.99)");
	assert.equal(context.events()[0].starts_at, Date.parse("2026-04-01T07:00:00.000Z") / 1000, "09:00 CEST");
});

test("a failing notice or calendar write never stops the loop and logs only the id and a code", async (t) => {
	const context = await setup(t);
	context.db.db.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-2', 'other', 'other.example', 'zone-2', 'active', 1);
		CREATE TRIGGER fail_reminder_events BEFORE INSERT ON calendar_events WHEN NEW.user_id = 'owner'
		BEGIN SELECT RAISE(ABORT, 'calendar unavailable'); END;
	`);
	context.addRow("fsub_a", { next: "2026-10-16" });
	context.addRow("fsub_b", { next: "2026-10-15", userId: "other" });
	context.failNotifyFor.add("owner");
	assert.deepEqual((await tick(NOW)).output, { reminded: 2 });
	assert.deepEqual(
		context.notices().map((notice) => notice.userId),
		["other"],
	);
	assert.deepEqual(
		context.events().map((event) => event.user_id),
		["other"],
	);
	assert.deepEqual(
		context
			.deliveries()
			.map((delivery) => delivery.webhookId)
			.sort(),
		["wh-other", "wh-owner"],
		"the webhook still went out for the row whose notice failed",
	);
	const failures = context.warnings.filter((line) => JSON.parse(line).event === "finance.reminder_failed");
	assert.equal(failures.length, 2, context.warnings.join("\n"));
	for (const line of failures) {
		const { fields } = JSON.parse(line);
		assert.deepEqual(Object.keys(fields).sort(), ["code", "subscriptionId"]);
		assert.equal(fields.subscriptionId, "fsub_a");
		assert.match(fields.code, /^[a-z_]+$/);
		// The line's own timestamp may carry the renewal date, so only the logged fields are checked.
		assert.doesNotMatch(JSON.stringify(fields), /Acmeflix|17\.99|1799|2026-10-16|https?:|owner@example/);
	}
});

test("at most 100 rows are handled per tick and the rest on the next", async (t) => {
	const context = await setup(t);
	for (let index = 0; index < 105; index += 1)
		context.addRow(`fsub_${String(index).padStart(3, "0")}`, { next: "2026-10-16", calendarReminder: 0 });
	assert.deepEqual((await tick(NOW)).output, { reminded: 100 });
	assert.deepEqual((await tick(NOW)).output, { reminded: 5 });
	assert.equal(context.notices().length, 105);
});

test("restricted owners do not block an enabled owner's reminders beyond the first page", async (t) => {
	const context = await setup(t);
	for (let index = 0; index < 200; index += 1)
		context.addRow(`fsub_a${String(index).padStart(3, "0")}`, { next: "2026-10-14", calendarReminder: 0 });
	context.restrict("owner", "finance");
	context.addRow("fsub_z", { next: "2026-10-14", userId: "other" });
	assert.deepEqual((await tick(NOW)).output, { reminded: 1 });
	assert.deepEqual(
		context.notices().map((notice) => notice.userId),
		["other"],
	);
	assert.equal(context.events().length, 1);
	assert.equal(context.subscription("fsub_a000").last_reminded_for, null, "restricted rows stay untouched");
	context.allow("owner", "finance");
	assert.deepEqual((await tick(NOW)).output, { reminded: 100 });
	assert.deepEqual((await tick(NOW)).output, { reminded: 100 });
});

test("rows waiting for their owner's calendar day do not consume the batch", async (t) => {
	const context = await setup(t, { timeZone: "Pacific/Honolulu" });
	for (let index = 0; index < 100; index += 1)
		context.addRow(`fsub_a${String(index).padStart(3, "0")}`, { next: "2026-10-17", calendarReminder: 0 });
	context.addRow("fsub_z", { next: "2026-10-17", userId: "other" });
	assert.deepEqual((await tick("2026-10-14T00:30:00.000Z")).output, { reminded: 1 });
	assert.deepEqual(
		context.notices().map((notice) => notice.userId),
		["other"],
	);
	assert.equal(context.subscription("fsub_a000").last_reminded_for, null);
	assert.deepEqual((await tick("2026-10-14T12:00:00.000Z")).output, { reminded: 100 });
});

test("paging past claimed rows does not skip eligible rows when the selection shrinks", async (t) => {
	const context = await setup(t, { timeZone: "Pacific/Honolulu" });
	for (let index = 0; index < 50; index += 1)
		context.addRow(`fsub_a${index}`, { next: "2026-10-14", calendarReminder: 0 });
	for (let index = 0; index < 100; index += 1)
		context.addRow(`fsub_b${index}`, { next: "2026-10-17", calendarReminder: 0 });
	for (let index = 0; index < 55; index += 1)
		context.addRow(`fsub_z${index}`, { next: "2026-10-17", userId: "other", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-14T00:30:00.000Z")).output, { reminded: 100 });
	assert.deepEqual((await tick("2026-10-14T00:35:00.000Z")).output, { reminded: 5 });
	assert.equal(context.notices().length, 105);
	assert.equal(context.subscription("fsub_b0").last_reminded_for, null);
});

test("before the Money Watch tables exist the cron returns without work", async (t) => {
	const context = await setup(t);
	context.db.db.exec("DROP TABLE finance_charges; DROP TABLE finance_subscriptions;");
	assert.deepEqual(await tick(NOW), { ok: true, output: { reminded: 0 } });
});

// --- The calendar event follows the subscription ------------------------------------------------

const owner = { id: "owner", email: "owner@example.com", role: "user", isPrimaryAdmin: false, timeZone: "UTC" };
const today = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

async function trackedAndReminded(context) {
	const added = await addSubscription(owner, {
		vendor: VENDOR,
		amountMinor: 1799,
		currency: "USD",
		cycle: "monthly",
		nextRenewalOn: today(2),
		reminderDays: 3,
		calendarReminder: true,
		mailboxId: "mailbox-a",
	});
	assert.equal(added.status, 200, JSON.stringify(added.body));
	const id = added.body.subscription.id;
	assert.equal((await tick(new Date().toISOString())).output.reminded, 1);
	assert.equal(context.events().length, 1);
	return { id, actionId: added.body.actionId };
}

test("turning the calendar reminder off removes the event and undo brings it back without a second notice", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	const reminded = context.subscription(id).last_reminded_for;
	const off = await changeSubscription(owner, id, { calendarReminder: false });
	assert.equal(off.status, 200, JSON.stringify(off.body));
	assert.deepEqual(context.events(), []);
	assert.equal(context.subscription(id).calendar_event_id, null);
	await undoAgentAction(context.env, owner, off.body.actionId);
	assert.equal(context.events().length, 1, "the event is back");
	assert.equal(context.subscription(id).calendar_event_id, context.events()[0].id);
	assert.equal(context.subscription(id).last_reminded_for, reminded, "last_reminded_for is unchanged");
	assert.equal(context.notices().length, 1, "no second notice");
	await tick(new Date().toISOString());
	assert.equal(context.notices().length, 1);
	assert.equal(context.events().length, 1);
});

test("reminder days off, cancelling or expiring removes the event; undoing the status brings it back", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	const zero = await changeSubscription(owner, id, { reminderDays: 0 });
	assert.deepEqual(context.events(), []);
	await undoAgentAction(context.env, owner, zero.body.actionId);
	assert.equal(context.events().length, 1);
	for (const status of ["cancelled", "expired"]) {
		const changed = await changeSubscription(owner, id, { status });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.deepEqual(context.events(), [], status);
		await undoAgentAction(context.env, owner, changed.body.actionId);
		assert.equal(context.events().length, 1, `undo of ${status}`);
	}
	assert.equal(context.notices().length, 1);
});

test("changing the renewal date moves the event", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	const [before] = context.events();
	const moved = await changeSubscription(owner, id, { fields: { nextRenewalOn: today(20) } });
	assert.equal(moved.status, 200, JSON.stringify(moved.body));
	const [after_] = context.events();
	assert.equal(context.events().length, 1);
	assert.equal(after_.id, before.id);
	assert.equal(after_.starts_at, Date.parse(`${today(20)}T09:00:00.000Z`) / 1000);
});

test("removing the subscription or undoing its creation removes the event; undoing the removal restores both", async (t) => {
	const context = await setup(t);
	const { id, actionId } = await trackedAndReminded(context);
	const removed = await removeSubscription(owner, id);
	assert.equal(removed.status, 200, JSON.stringify(removed.body));
	assert.deepEqual(context.events(), []);
	await undoAgentAction(context.env, owner, removed.body.actionId);
	assert.ok(context.subscription(id), "the row is back");
	assert.equal(context.events().length, 1, "and so is its event");
	await undoAgentAction(context.env, owner, actionId);
	assert.equal(context.subscription(id), undefined);
	assert.deepEqual(context.events(), []);
});

test("turning Calendar off for the user leaves existing events in place", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	context.restrict("owner", "calendar");
	const cancelled = await changeSubscription(owner, id, { status: "cancelled" });
	assert.equal(cancelled.status, 200);
	assert.equal(context.events().length, 1);
});

test("undoing a calendar reminder off after the date moved past its claim brings the event back at the new date", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	const reminded = context.subscription(id).last_reminded_for;
	const moved = await changeSubscription(owner, id, { fields: { nextRenewalOn: today(20) } });
	assert.equal(moved.status, 200, JSON.stringify(moved.body));
	const off = await changeSubscription(owner, id, { calendarReminder: false });
	assert.equal(off.status, 200, JSON.stringify(off.body));
	assert.deepEqual(context.events(), []);
	await undoAgentAction(context.env, owner, off.body.actionId);
	const events = context.events();
	assert.equal(events.length, 1, "the event is back");
	assert.equal(events[0].starts_at, Date.parse(`${today(20)}T09:00:00.000Z`) / 1000, "at the new date");
	assert.equal(context.subscription(id).calendar_event_id, events[0].id);
	assert.equal(context.subscription(id).last_reminded_for, reminded, "last_reminded_for is unchanged");
	assert.equal(context.notices().length, 1, "no second notice");
});

test("undoing the removal of a row whose date moved past its claim restores its event without a notice", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	const reminded = context.subscription(id).last_reminded_for;
	await changeSubscription(owner, id, { fields: { nextRenewalOn: today(20) } });
	const [before] = context.events();
	const removed = await removeSubscription(owner, id);
	assert.equal(removed.status, 200, JSON.stringify(removed.body));
	assert.deepEqual(context.events(), []);
	await undoAgentAction(context.env, owner, removed.body.actionId);
	const events = context.events();
	assert.equal(events.length, 1, "the event is back");
	assert.notEqual(events[0].id, before.id, "a new event, not the deleted one's id");
	assert.equal(events[0].starts_at, Date.parse(`${today(20)}T09:00:00.000Z`) / 1000);
	assert.equal(context.subscription(id).calendar_event_id, events[0].id);
	assert.equal(context.subscription(id).last_reminded_for, reminded);
	assert.equal(context.notices().length, 1, "no second notice");
});

test("undoing a change on a moved row that had no calendar event leaves it to the cron", async (t) => {
	const context = await setup(t);
	const { id } = await trackedAndReminded(context);
	await changeSubscription(owner, id, { fields: { nextRenewalOn: today(20) } });
	const off = await changeSubscription(owner, id, { calendarReminder: false });
	const plan = await changeSubscription(owner, id, { fields: { plan: "Family" } });
	assert.equal(plan.status, 200, JSON.stringify(plan.body));
	await undoAgentAction(context.env, owner, plan.body.actionId);
	assert.deepEqual(context.events(), [], "the plan change never had an event to restore");
	await undoAgentAction(context.env, owner, off.body.actionId);
	assert.equal(context.events().length, 1);
});

// --- Selection and claims at the edges ------------------------------------------------------------

const unix = (day) => Date.parse(`${day}T00:00:00.000Z`) / 1000;

test("a UTC owner's due date is reminded until local midnight and claimed silently from then on", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_today", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-14T23:59:59.000Z")).output, { reminded: 1 });
	assert.equal(context.notices()[0].title, "Acmeflix renews today ($17.99)");
	context.addRow("fsub_late", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-15T00:00:00.000Z")).output, { reminded: 0 });
	assert.equal(context.subscription("fsub_late").last_reminded_for, unix("2026-10-14"), "claimed silently");
	assert.equal(context.notices().length, 1);
});

test("a negative-offset owner is reminded for the whole local due day, past the next UTC midnight", async (t) => {
	const context = await setup(t, { timeZone: "Pacific/Honolulu" });
	// 05:00 UTC on 15 October is 19:00 on 14 October in Honolulu (UTC-10).
	context.addRow("fsub_today", { next: "2026-10-14" });
	assert.deepEqual((await tick("2026-10-15T05:00:00.000Z")).output, { reminded: 1 });
	assert.deepEqual(
		context.notices().map((notice) => notice.title),
		["Acmeflix renews today ($17.99)"],
	);
	assert.equal(context.subscription("fsub_today").last_reminded_for, unix("2026-10-14"));
	const [event] = context.events();
	assert.equal(event.starts_at, Date.parse("2026-10-14T19:00:00.000Z") / 1000, "09:00 in Honolulu");

	// The last minute of the local day still reminds; local midnight (10:00 UTC) only claims.
	context.addRow("fsub_edge", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-15T09:59:00.000Z")).output, { reminded: 1 });
	context.addRow("fsub_after", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-15T10:00:00.000Z")).output, { reminded: 0 });
	assert.equal(context.subscription("fsub_after").last_reminded_for, unix("2026-10-14"), "claimed silently");
	assert.equal(context.notices().length, 2);
});

test("at UTC-12 the due date is still selected 36 hours after its UTC midnight", async (t) => {
	const context = await setup(t, { timeZone: "Etc/GMT+12" });
	context.addRow("fsub_today", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-15T11:59:00.000Z")).output, { reminded: 1 });
	assert.equal(context.notices()[0].title, "Acmeflix renews today ($17.99)");
	context.addRow("fsub_after", { next: "2026-10-14", calendarReminder: 0 });
	assert.deepEqual((await tick("2026-10-15T12:00:00.000Z")).output, { reminded: 0 });
	assert.equal(context.subscription("fsub_after").last_reminded_for, unix("2026-10-14"));
});

test("a claim rechecks the live row: status, reminder days, due date and an earlier claim", async (t) => {
	const context = await setup(t);
	const update = (statement) => context.db.db.prepare(statement).run();
	context.addRow("fsub_ok", { next: "2026-10-16" });
	context.addRow("fsub_trial", { status: "trial", trial: "2026-10-15", next: "2026-11-15" });
	context.addRow("fsub_cancelled", { next: "2026-10-16" });
	context.addRow("fsub_off", { next: "2026-10-16" });
	context.addRow("fsub_moved", { next: "2026-10-16" });
	context.addRow("fsub_claimed", { next: "2026-10-16" });
	const selected = await dueRows(new Date(NOW), 100);
	assert.equal(selected.length, 6);
	update("UPDATE finance_subscriptions SET status = 'cancelled' WHERE id = 'fsub_cancelled'");
	update("UPDATE finance_subscriptions SET reminder_days = 0 WHERE id = 'fsub_off'");
	update(`UPDATE finance_subscriptions SET next_renewal_at = ${unix("2026-10-17")} WHERE id = 'fsub_moved'`);
	update(`UPDATE finance_subscriptions SET last_reminded_for = ${unix("2026-10-16")} WHERE id = 'fsub_claimed'`);
	const claims = {};
	for (const selectedRow of selected) {
		const dueAt = selectedRow.status === "trial" ? selectedRow.trialEndsAt : selectedRow.nextRenewalAt;
		claims[selectedRow.id] = await claimReminder(selectedRow.id, dueAt);
	}
	assert.deepEqual(claims, {
		fsub_ok: true,
		fsub_trial: true,
		fsub_cancelled: false,
		fsub_off: false,
		fsub_moved: false,
		fsub_claimed: false,
	});
	assert.equal(context.subscription("fsub_trial").last_reminded_for, unix("2026-10-15"));
	for (const id of ["fsub_cancelled", "fsub_off", "fsub_moved"])
		assert.equal(context.subscription(id).last_reminded_for, null, id);
	assert.equal(await claimReminder("fsub_ok", new Date("2026-10-16T00:00:00.000Z")), false, "once per date");
	assert.equal(await claimReminder("fsub_trial", new Date("2026-11-15T00:00:00.000Z")), false, "a trial's renewal");
});

test("a row cancelled while the tick that selected it is still running is not reminded", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_first", { next: "2026-10-15" });
	context.addRow("fsub_cancelled", { next: "2026-10-16" });
	context.duringNextNotice(async () => {
		const cancelled = await changeSubscription(owner, "fsub_cancelled", { status: "cancelled" });
		assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
	});
	assert.deepEqual((await tick(NOW)).output, { reminded: 1 });
	assert.deepEqual(
		context.notices().map((notice) => notice.href),
		["/finance?subscription=fsub_first"],
	);
	assert.equal(context.subscription("fsub_cancelled").status, "cancelled");
	assert.equal(context.subscription("fsub_cancelled").last_reminded_for, null);
	assert.equal(context.subscription("fsub_cancelled").calendar_event_id, null);
	assert.deepEqual(
		context.events().map((event) => event.ical_uid),
		["finance-renewal:fsub_first"],
		"no event for the cancelled row",
	);
	assert.deepEqual(
		context.deliveries().map((delivery) => delivery.body.data.subscription.ref.id),
		["fsub_first"],
	);
});

test("a stale tick never overwrites a newer cycle's claim, so the new date is announced once", async (t) => {
	const context = await setup(t);
	context.addRow("fsub_first", { next: "2026-10-15", calendarReminder: 0 });
	context.addRow("fsub_moved", { next: "2026-10-16", calendarReminder: 0 });
	// While the first tick still holds fsub_moved due 16 October, the date moves and a second tick claims it.
	context.duringNextNotice(async () => {
		context.db.db
			.prepare("UPDATE finance_subscriptions SET next_renewal_at = ? WHERE id = 'fsub_moved'")
			.run(unix("2026-10-17"));
		assert.deepEqual((await tick("2026-10-14T12:01:00.000Z")).output, { reminded: 1 });
	});
	assert.deepEqual((await tick(NOW)).output, { reminded: 1 });
	assert.equal(context.subscription("fsub_moved").last_reminded_for, unix("2026-10-17"), "the newer claim stays");
	assert.deepEqual((await tick("2026-10-14T12:05:00.000Z")).output, { reminded: 0 });
	assert.deepEqual(
		context.notices().map((notice) => notice.title),
		["Acmeflix renews tomorrow ($17.99)", "Acmeflix renews in 3 days ($17.99)"],
	);
});
