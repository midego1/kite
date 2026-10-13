import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	blockingDependency,
	summarizeCapabilities,
	buildModuleAdminEntries,
	dependentsTurningOff,
	turnOffWarning,
	accessSummary,
	loadModuleAdminView,
	loadUserModuleAccess,
	setInstallModule,
	setUserModuleAccess,
	MODULE_AUDIT_ACTIONS,
	listEnabledModules,
	MODULE_MANIFESTS,
	MODULE_CAPABILITIES,
} = await bundleModules("kite-module-admin-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	[
		"blockingDependency, summarizeCapabilities, buildModuleAdminEntries, dependentsTurningOff, turnOffWarning, accessSummary, MODULE_AUDIT_ACTIONS",
		"src/lib/modules/admin-utils.ts",
	],
	["loadModuleAdminView, loadUserModuleAccess, setInstallModule, setUserModuleAccess", "src/lib/modules/admin.ts"],
	["listEnabledModules", "src/lib/modules/state.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
]);

const ALL = ["calendar", "booking", "templates", "import"];
const OWNER = { id: "owner" };
const manifests = [
	{ id: "a", name: "A", dependsOn: [], defaultEnabled: true },
	{ id: "b", name: "B", dependsOn: ["a"], defaultEnabled: true },
	{ id: "c", name: "C", dependsOn: ["b"], defaultEnabled: true },
];

test("blockingDependency names the nearest dependency that is not on for the install", () => {
	assert.equal(blockingDependency(manifests, new Map(), "b"), null);
	assert.equal(blockingDependency(manifests, new Map([["a", false]]), "b")?.id, "a");
	// c needs b, and b is off only because a is.
	assert.equal(blockingDependency(manifests, new Map([["a", false]]), "c")?.id, "b");
	assert.equal(blockingDependency(manifests, new Map([["b", false]]), "c")?.id, "b");
	assert.equal(blockingDependency(manifests, new Map([["a", false]]), "a"), null);
});

test("summarizeCapabilities lists tools, scopes, events and commands from the declarations only", () => {
	const manifest = MODULE_MANIFESTS.find((item) => item.id === "calendar");
	const capabilities = MODULE_CAPABILITIES.find((item) => item.moduleId === "calendar");
	const summary = summarizeCapabilities(manifest, capabilities.descriptors);
	assert.ok(summary.tools.some((tool) => tool.name === "get_schedule"));
	assert.ok(summary.tools.every((tool) => tool.description));
	assert.deepEqual(summary.scopes.map((scope) => scope.scope).sort(), [
		"calendar:read",
		"calendar:write",
		"mcp:calendar-read",
		"mcp:calendar-write",
	]);
	assert.deepEqual(
		summary.webhookEvents.map((event) => event.value),
		["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"],
	);
	const ids = summary.commands.map((command) => command.id);
	assert.ok(ids.includes("calendar.open") && ids.includes("calendar.go_to_date"));
	assert.ok(!ids.some((id) => id.startsWith("booking.")));
});

test("summarizeCapabilities reports nothing for a module that adds none", () => {
	const manifest = MODULE_MANIFESTS.find((item) => item.id === "templates");
	const capabilities = MODULE_CAPABILITIES.find((item) => item.moduleId === "templates");
	const summary = summarizeCapabilities(manifest, capabilities.descriptors);
	assert.deepEqual([summary.tools, summary.scopes, summary.webhookEvents], [[], [], []]);
});

test("buildModuleAdminEntries keeps registry order, stored flags and the reason a module is off", () => {
	const entries = buildModuleAdminEntries({
		manifests: MODULE_MANIFESTS,
		capabilities: MODULE_CAPABILITIES,
		install: new Map([
			["calendar", false],
			["booking", true],
			["templates", true],
			["import", false],
		]),
		restricted: [{ id: "u1", name: "Member", email: "m@example.com", moduleId: "templates" }],
	});
	assert.deepEqual(
		entries.map((entry) => entry.id),
		ALL,
	);
	const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
	assert.equal(byId.booking.enabled, true);
	assert.equal(byId.booking.effective, false);
	assert.deepEqual(byId.booking.offBecause, { id: "calendar", name: "Calendar" });
	assert.deepEqual(byId.booking.dependsOn, [{ id: "calendar", name: "Calendar" }]);
	assert.deepEqual(byId.calendar.dependents, [{ id: "booking", name: "Booking" }]);
	assert.equal(byId.calendar.offBecause, null);
	assert.equal(byId.import.offBecause, null);
	assert.equal(byId.import.effective, false);
	assert.deepEqual(byId.templates.restrictedUsers, [{ id: "u1", name: "Member", email: "m@example.com" }]);
	assert.deepEqual(byId.calendar.restrictedUsers, []);
	assert.ok(byId.import.adminNotes[0].startsWith("Turning this off pauses running imports."));
});

function entriesFor(install, restricted = []) {
	return buildModuleAdminEntries({
		manifests: MODULE_MANIFESTS,
		capabilities: MODULE_CAPABILITIES,
		install,
		restricted,
	});
}

test("turning Calendar off warns that Booking goes off too, or says it already is", () => {
	const on = entriesFor(new Map());
	const calendar = on.find((entry) => entry.id === "calendar");
	assert.deepEqual(dependentsTurningOff(calendar, on), [{ id: "booking", name: "Booking" }]);
	assert.match(turnOffWarning(calendar, on), /Booking needs Calendar, so Booking will be turned off too\./);
	const bookingOff = entriesFor(new Map([["booking", false]]));
	assert.deepEqual(dependentsTurningOff(bookingOff[0], bookingOff), []);
	assert.match(turnOffWarning(bookingOff[0], bookingOff), /Booking needs Calendar and is already off/);
});

test("the access summary says everyone has access, or counts and names the restricted users", () => {
	const none = entriesFor(new Map());
	assert.equal(accessSummary(none[0]), "Every user has access.");
	const one = entriesFor(new Map(), [{ id: "u1", name: "Member C", email: "c@example.com", moduleId: "calendar" }]);
	assert.equal(accessSummary(one[0]), "1 user is restricted: Member C.");
	const two = entriesFor(new Map(), [
		{ id: "u1", name: "", email: "c@example.com", moduleId: "calendar" },
		{ id: "u2", name: "D", email: "d@example.com", moduleId: "calendar" },
	]);
	assert.equal(accessSummary(two[0]), "2 users are restricted: c@example.com, D.");
});

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1),
			('member', 'member@example.com', 'hash', 'Member', 'user', 0, 1);
	`);
	return { db, env: { DB: db } };
}

const audits = (db) =>
	db.db.prepare("SELECT action, actor_user_id, target_user_id, metadata FROM audit_logs ORDER BY rowid").all();

test("the owner view lists the four modules on, in order, with no restrictions", async (t) => {
	const { env } = await database(t);
	const view = await loadModuleAdminView(env);
	assert.equal(view.migrationPending, false);
	assert.deepEqual(
		view.modules.map((entry) => [entry.id, entry.enabled, entry.effective]),
		ALL.map((id) => [id, true, true]),
	);
	assert.ok(view.modules.every((entry) => entry.restrictedUsers.length === 0));
});

test("turning a module off and on stores the flag, writes audit rows and is visible at once", async (t) => {
	const { db, env } = await database(t);
	assert.deepEqual(await listEnabledModules(env, null), ALL);
	const off = await setInstallModule(env, OWNER, { moduleId: "templates", enabled: false });
	assert.deepEqual(off, { ok: true, changed: true });
	assert.deepEqual(await listEnabledModules(env, null), ["calendar", "booking", "import"]);
	assert.equal((await loadModuleAdminView(env)).modules.find((entry) => entry.id === "templates").enabled, false);
	await setInstallModule(env, OWNER, { moduleId: "templates", enabled: true });
	assert.deepEqual(
		audits(db).map((row) => [row.action, row.actor_user_id, JSON.parse(row.metadata).moduleId]),
		[
			["module.disabled", "owner", "templates"],
			["module.enabled", "owner", "templates"],
		],
	);
	assert.deepEqual([...MODULE_AUDIT_ACTIONS], ["module.enabled", "module.disabled", "module.user_access"]);
});

test("a change that changes nothing writes no audit row", async (t) => {
	const { db, env } = await database(t);
	assert.deepEqual(await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: true }), {
		ok: true,
		changed: false,
	});
	assert.deepEqual(audits(db), []);
});

test("Calendar off leaves Booking's stored flag alone and Booking cannot be turned on meanwhile", async (t) => {
	const { db, env } = await database(t);
	await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: false });
	const entry = (await loadModuleAdminView(env)).modules.find((item) => item.id === "booking");
	assert.equal(entry.enabled, true);
	assert.equal(entry.effective, false);
	assert.equal(entry.offBecause.id, "calendar");

	const refused = await setInstallModule(env, OWNER, { moduleId: "booking", enabled: true });
	assert.equal(refused.ok, false);
	assert.equal(refused.status, 409);
	assert.equal(refused.code, "MODULE_DEPENDENCY");
	assert.match(refused.error, /Calendar/);
	// Only the Calendar change was audited; the refusal wrote nothing.
	assert.deepEqual(
		audits(db).map((row) => row.action),
		["module.disabled"],
	);

	await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: true });
	assert.deepEqual(await listEnabledModules(env, null), ALL);
});

test("Booking turned off before Calendar stays off when Calendar returns", async (t) => {
	const { env } = await database(t);
	await setInstallModule(env, OWNER, { moduleId: "booking", enabled: false });
	await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: false });
	await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: true });
	assert.deepEqual(await listEnabledModules(env, null), ["calendar", "templates", "import"]);
});

test("restricting a user writes one audit row per changed module with a user ref and affects only that user", async (t) => {
	const { db, env } = await database(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', 'hash', 'Other', 1)",
	);
	const result = await setUserModuleAccess(env, OWNER, "member", [
		{ moduleId: "import", allowed: false },
		{ moduleId: "templates", allowed: true },
	]);
	assert.deepEqual(result, { ok: true, changed: 1 });
	const member = { userId: "member", role: "user", isPrimaryAdmin: false };
	const other = { userId: "other", role: "user", isPrimaryAdmin: false };
	assert.deepEqual(await listEnabledModules(env, member), ["calendar", "booking", "templates"]);
	assert.deepEqual(await listEnabledModules(env, other), ALL);
	const rows = audits(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].action, "module.user_access");
	assert.equal(rows[0].target_user_id, "member");
	assert.deepEqual(JSON.parse(rows[0].metadata), {
		moduleId: "import",
		allowed: false,
		ref: { kind: "user:user", id: "member" },
	});
	const view = await loadModuleAdminView(env);
	assert.deepEqual(view.modules.find((entry) => entry.id === "import").restrictedUsers, [
		{ id: "member", name: "Member", email: "member@example.com" },
	]);
	const access = await loadUserModuleAccess(env, "member");
	assert.deepEqual(
		access.modules.map((entry) => [entry.id, entry.allowed]),
		[
			["calendar", true],
			["booking", true],
			["templates", true],
			["import", false],
		],
	);

	await setUserModuleAccess(env, OWNER, "member", [{ moduleId: "import", allowed: true }]);
	assert.deepEqual(await listEnabledModules(env, member), ALL);
});

test("the owner's access cannot be restricted and an unknown user is not found", async (t) => {
	const { db, env } = await database(t);
	const refused = await setUserModuleAccess(env, OWNER, "owner", [{ moduleId: "calendar", allowed: false }]);
	assert.equal(refused.ok, false);
	assert.equal(refused.status, 400);
	assert.equal(refused.code, "OWNER_ACCESS");
	assert.deepEqual(await setUserModuleAccess(env, OWNER, "owner", [{ moduleId: "calendar", allowed: true }]), {
		ok: true,
		changed: 0,
	});
	const missing = await setUserModuleAccess(env, OWNER, "nobody", [{ moduleId: "calendar", allowed: false }]);
	assert.equal(missing.status, 404);
	assert.deepEqual(audits(db), []);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM user_module_access").get().count, 0);
});

test("before migration 0062 the view reads as on, reports the pending update and refuses writes", async (t) => {
	const { db, env } = await database(t);
	db.db.exec(`
		DROP TRIGGER IF EXISTS calendar_events_fts_ai;
		DROP TRIGGER IF EXISTS calendar_events_fts_ad;
		DROP TRIGGER IF EXISTS calendar_events_fts_au;
		DROP TABLE calendar_events_fts;
		DROP TABLE booking_appointments;
		DROP TABLE user_module_access;
		DROP TABLE module_settings;
	`);
	const view = await loadModuleAdminView(env);
	assert.equal(view.migrationPending, true);
	assert.deepEqual(
		view.modules.map((entry) => [entry.id, entry.enabled, entry.effective]),
		ALL.map((id) => [id, true, true]),
	);
	const off = await setInstallModule(env, OWNER, { moduleId: "calendar", enabled: false });
	assert.equal(off.status, 409);
	assert.equal(off.code, "MIGRATION_PENDING");
	const access = await setUserModuleAccess(env, OWNER, "member", [{ moduleId: "calendar", allowed: false }]);
	assert.equal(access.code, "MIGRATION_PENDING");
	assert.equal((await loadUserModuleAccess(env, "member")).migrationPending, true);
});
