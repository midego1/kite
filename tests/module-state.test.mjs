import assert from "node:assert/strict";
import { join } from "node:path";
import test, { mock } from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	effectiveModules,
	flagsFromRows,
	isNoSuchTableError,
	getInstallModuleState,
	getUserModuleAccess,
	isModuleEnabled,
	isModuleEnabledFor,
	listEnabledModules,
	setModuleEnabled,
	setUserModuleAllowed,
	clearModuleStateCache,
	readStoredInstallState,
	readStoredUserAccess,
	MODULE_MANIFESTS,
} = await bundleModules("kite-module-state-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["effectiveModules, flagsFromRows, isNoSuchTableError", "src/lib/modules/state-utils.ts"],
	[
		"getInstallModuleState, getUserModuleAccess, isModuleEnabled, isModuleEnabledFor, listEnabledModules, setModuleEnabled, setUserModuleAllowed, clearModuleStateCache, readStoredInstallState, readStoredUserAccess",
		"src/lib/modules/state.ts",
	],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
]);

const migrationsDir = join(root, "drizzle/migrations");
const ALL = ["calendar", "booking", "templates", "import"];
const OWNER = { userId: "owner", role: "admin", isPrimaryAdmin: true };
const MEMBER = { userId: "member", role: "user", isPrimaryAdmin: false };

const manifests = [
	{ id: "a", dependsOn: [], defaultEnabled: true },
	{ id: "b", dependsOn: ["a"], defaultEnabled: true },
	{ id: "c", dependsOn: ["b"], defaultEnabled: true },
	{ id: "d", dependsOn: [], defaultEnabled: false },
];
const sorted = (set) => [...set].sort();

test("effectiveModules turns a module off for an install flag, a dependency or a restriction", () => {
	assert.deepEqual(sorted(effectiveModules(new Map(), new Map(), manifests)), ["a", "b", "c"]);
	assert.deepEqual(sorted(effectiveModules(new Map([["b", false]]), new Map(), manifests)), ["a"]);
	// Transitive: c depends on b, b on a.
	assert.deepEqual(sorted(effectiveModules(new Map([["a", false]]), new Map(), manifests)), []);
	assert.deepEqual(sorted(effectiveModules(new Map(), new Map([["a", false]]), manifests)), []);
	assert.deepEqual(sorted(effectiveModules(new Map(), new Map([["c", false]]), manifests)), ["a", "b"]);
});

test("a dependency that is off never rewrites the stored flag of its dependent", () => {
	const install = new Map([
		["a", false],
		["b", true],
	]);
	assert.deepEqual(sorted(effectiveModules(install, new Map(), manifests)), []);
	assert.equal(install.get("b"), true);
	install.set("a", true);
	assert.deepEqual(sorted(effectiveModules(install, new Map(), manifests)), ["a", "b", "c"]);
});

test("missing entries use defaultEnabled for the install and allowed for access", () => {
	assert.deepEqual(sorted(effectiveModules(new Map([["d", true]]), new Map(), manifests)), ["a", "b", "c", "d"]);
	assert.deepEqual(sorted(effectiveModules(new Map(), new Map([["d", true]]), manifests)), ["a", "b", "c"]);
});

test("effectiveModules refuses cycles and unknown dependencies instead of looping", () => {
	const cyclic = [
		{ id: "x", dependsOn: ["y"], defaultEnabled: true },
		{ id: "y", dependsOn: ["x"], defaultEnabled: true },
		{ id: "z", dependsOn: ["gone"], defaultEnabled: true },
	];
	assert.deepEqual(sorted(effectiveModules(new Map(), new Map(), cyclic)), []);
});

test("flagsFromRows fills every manifest and ignores unknown modules", () => {
	const flags = flagsFromRows(
		[
			{ moduleId: "a", flag: false },
			{ moduleId: "retired", flag: false },
		],
		manifests,
		(manifest) => manifest.defaultEnabled,
	);
	assert.deepEqual(
		[...flags],
		[
			["a", false],
			["b", true],
			["c", true],
			["d", false],
		],
	);
});

test("isNoSuchTableError recognises the D1, better-sqlite3 and wrapped messages", () => {
	assert.equal(isNoSuchTableError(new Error("no such table: module_settings")), true);
	assert.equal(isNoSuchTableError(new Error("D1_ERROR: no such table: module_settings: SQLITE_ERROR")), true);
	assert.equal(isNoSuchTableError(new Error("Failed query", { cause: new Error("no such table: x") })), true);
	assert.equal(isNoSuchTableError(new Error("database is locked")), false);
	assert.equal(isNoSuchTableError(null), false);
	assert.equal(isNoSuchTableError("D1_ERROR: no such table: x"), true);
});

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1);
	`);
	return db;
}

/** A D1 stand-in that counts the queries that read a table. */
function counting(db, table) {
	const wrapped = Object.create(db);
	wrapped.reads = 0;
	wrapped.prepare = (sql) => {
		if (/^\s*select/i.test(sql) && sql.includes(`"${table}"`)) wrapped.reads++;
		return db.prepare(sql);
	};
	return wrapped;
}

test("the migration seeds every module on and nobody restricted", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	assert.deepEqual(
		[...(await getInstallModuleState(env))],
		ALL.map((id) => [id, true]),
	);
	assert.deepEqual(await listEnabledModules(env, MEMBER), ALL);
	assert.deepEqual(await listEnabledModules(env, null), ALL);
	assert.equal(await isModuleEnabled(env, "booking"), true);
	assert.deepEqual(
		MODULE_MANIFESTS.map((manifest) => manifest.id),
		ALL,
	);
});

test("install state, dependencies and per-user access combine", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	db.db.exec(`
		UPDATE module_settings SET enabled = 0 WHERE module_id = 'templates';
		INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'import', 0, 1);
	`);
	assert.deepEqual(await listEnabledModules(env, MEMBER), ["calendar", "booking"]);
	assert.deepEqual(await listEnabledModules(env, null), ["calendar", "booking", "import"]);
	assert.equal(await isModuleEnabledFor(env, MEMBER, "import"), false);
	assert.equal(await isModuleEnabledFor(env, OWNER, "import"), true);
	assert.equal(await isModuleEnabled(env, "import"), true);
	assert.equal(await isModuleEnabled(env, "templates"), false);
});

test("Booking is off whenever Calendar is off, without changing its stored flag", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	assert.deepEqual(await listEnabledModules(env, OWNER), ["templates", "import"]);
	assert.equal(db.db.prepare("SELECT enabled FROM module_settings WHERE module_id = 'booking'").get().enabled, 1);
	assert.equal((await getInstallModuleState(env)).get("booking"), true);
});

test("a user restricted from Calendar loses Booking too", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'calendar', 0, 1)",
	);
	assert.deepEqual(await listEnabledModules({ DB: db }, MEMBER), ["templates", "import"]);
});

test("the primary admin is never restricted, whatever a stored row says", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	db.db.exec(`
		INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES
			('u1', 'owner', 'calendar', 0, 1), ('u2', 'owner', 'import', 0, 1);
	`);
	assert.deepEqual(await listEnabledModules(env, OWNER), ALL);
	assert.deepEqual(
		[...(await getUserModuleAccess(env, OWNER))],
		ALL.map((id) => [id, true]),
	);
	assert.equal(await isModuleEnabledFor(env, OWNER, "calendar"), true);
});

test("a row with no match uses defaultEnabled and allowed", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	db.db.exec("DELETE FROM module_settings");
	assert.deepEqual(await listEnabledModules(env, MEMBER), ALL);
	assert.deepEqual(
		[...(await getUserModuleAccess(env, MEMBER))],
		ALL.map((id) => [id, true]),
	);
});

for (const [label, tables] of [
	["both module tables", ["user_module_access", "module_settings"]],
	["user_module_access", ["user_module_access"]],
]) {
	test(`a database without ${label} (before 0062) reads as every module enabled and every user allowed`, async (t) => {
		const db = await database(t);
		for (const table of tables) db.db.exec(`DROP TABLE ${table}`);
		const env = { DB: db };
		assert.deepEqual(await listEnabledModules(env, MEMBER), ALL);
		assert.deepEqual(await listEnabledModules(env, OWNER), ALL);
		assert.deepEqual(await listEnabledModules(env, null), ALL);
		assert.equal(await isModuleEnabledFor(env, MEMBER, "calendar"), true);
		assert.equal(await isModuleEnabled(env, "import"), true);
	});
}

test("the D1 wording of a missing table also reads as all enabled, other failures propagate", async (t) => {
	const db = await database(t);
	const failing = (message) => ({
		prepare: () => {
			throw new Error(message);
		},
	});
	assert.deepEqual(
		await listEnabledModules({ DB: failing("D1_ERROR: no such table: module_settings: SQLITE_ERROR") }, MEMBER),
		ALL,
	);
	await assert.rejects(
		listEnabledModules({ DB: failing("D1_ERROR: network connection lost") }, MEMBER),
		/Failed query|connection/,
	);
	// A failed read is not cached: the next call asks again.
	const flaky = counting(db, "module_settings");
	const original = flaky.prepare;
	let fail = true;
	flaky.prepare = (sql) => {
		if (fail) {
			fail = false;
			throw new Error("temporary");
		}
		return original(sql);
	};
	await assert.rejects(isModuleEnabled({ DB: flaky }, "calendar"));
	assert.equal(await isModuleEnabled({ DB: flaky }, "calendar"), true);
});

test("repeated state reads in one isolate query module_settings once for 30 seconds", async (t) => {
	mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	t.after(() => mock.timers.reset());
	const db = counting(await database(t), "module_settings");
	const env = { DB: db };
	await isModuleEnabled(env, "calendar");
	await isModuleEnabledFor(env, MEMBER, "booking");
	await listEnabledModules(env, OWNER);
	await getInstallModuleState(env);
	await Promise.all([isModuleEnabled(env, "import"), listEnabledModules(env, MEMBER), listEnabledModules(env, null)]);
	assert.equal(db.reads, 1);

	mock.timers.tick(29_999);
	await isModuleEnabled(env, "calendar");
	assert.equal(db.reads, 1);

	mock.timers.tick(2);
	await isModuleEnabled(env, "calendar");
	assert.equal(db.reads, 2);
	await listEnabledModules(env, MEMBER);
	assert.equal(db.reads, 2);
});

test("per-user access is cached per isolate too and read once per user", async (t) => {
	mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	t.after(() => mock.timers.reset());
	const db = counting(await database(t), "user_module_access");
	const env = { DB: db };
	await isModuleEnabledFor(env, MEMBER, "calendar");
	await listEnabledModules(env, MEMBER);
	await listEnabledModules(env, OWNER);
	assert.equal(db.reads, 1);
	mock.timers.tick(31_000);
	await listEnabledModules(env, MEMBER);
	assert.equal(db.reads, 2);
});

test("a write through the admin helper clears the isolate cache at once", async (t) => {
	mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	t.after(() => mock.timers.reset());
	const db = counting(await database(t), "module_settings");
	const env = { DB: db };
	assert.equal(await isModuleEnabled(env, "templates"), true);
	assert.equal(db.reads, 1);

	await setModuleEnabled(env, { moduleId: "templates", enabled: false, updatedBy: "owner" });
	assert.equal(await isModuleEnabled(env, "templates"), false);
	assert.equal(db.reads, 2);
	assert.deepEqual(await listEnabledModules(env, MEMBER), ["calendar", "booking", "import"]);
	assert.equal(db.reads, 2);

	assert.deepEqual(
		db.db.prepare("SELECT id, module_id, enabled, updated_by FROM module_settings WHERE module_id = 'templates'").all(),
		[{ id: "templates", module_id: "templates", enabled: 0, updated_by: "owner" }],
	);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM module_settings").get().count, 4);

	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	assert.deepEqual(await listEnabledModules(env, MEMBER), ["calendar", "booking"]);
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: true, updatedBy: "owner" });
	assert.deepEqual(await listEnabledModules(env, MEMBER), ["calendar", "booking", "import"]);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM user_module_access").get().count, 1);

	await setModuleEnabled(env, { moduleId: "templates", enabled: true, updatedBy: null });
	assert.equal(await isModuleEnabled(env, "templates"), true);
});

test("a write clears the cache even when it fails", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	assert.equal(await isModuleEnabled(env, "calendar"), true);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	// Stale until something clears it.
	assert.equal(await isModuleEnabled(env, "calendar"), true);
	await assert.rejects(
		setUserModuleAllowed(env, { userId: "missing-user", moduleId: "calendar", allowed: false, updatedBy: null }),
	);
	assert.equal(await isModuleEnabled(env, "calendar"), false);
});

test("clearModuleStateCache makes the next read ask the database again", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	assert.equal(await isModuleEnabled(env, "calendar"), true);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	assert.equal(await isModuleEnabled(env, "calendar"), true);
	clearModuleStateCache();
	assert.equal(await isModuleEnabled(env, "calendar"), false);
});

test("stored state reads skip the cache and say whether migration 0062 is applied", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	assert.equal(await isModuleEnabled(env, "calendar"), true);
	db.db.exec(`
		UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar';
		INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'import', 0, 1);
	`);
	const install = await readStoredInstallState(env);
	assert.equal(install.ready, true);
	assert.equal(install.flags.get("calendar"), false);
	assert.equal(install.flags.get("booking"), true);
	assert.equal((await readStoredUserAccess(env, "member")).flags.get("import"), false);
	assert.equal((await readStoredUserAccess(env, "owner")).flags.get("import"), true);

	db.db.exec("DROP TABLE user_module_access; DROP TABLE module_settings;");
	const missing = await readStoredInstallState(env);
	assert.equal(missing.ready, false);
	assert.deepEqual([...missing.flags.values()], [true, true, true, true]);
	assert.equal((await readStoredUserAccess(env, "member")).ready, false);
});
