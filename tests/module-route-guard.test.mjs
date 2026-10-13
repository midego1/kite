import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	MODULE_MANIFESTS,
	guardRoute,
	pageAccess,
	publicPageAccess,
	isModuleEnabled,
	isModuleEnabledFor,
} = await bundleModules("kite-module-route-guard-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["guardRoute, pageAccess, publicPageAccess", "src/lib/modules/route-guard-utils.ts"],
	["isModuleEnabled, isModuleEnabledFor", "src/lib/modules/state.ts"],
]);

const METHOD_EXPORT = /^export (?:async function|function|const) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

/** Every exported method of a route file with its source up to the next export, in file order. */
function methodsOf(source) {
	const starts = [...source.matchAll(METHOD_EXPORT)].map((match) => ({ method: match[1], index: match.index }));
	return starts.map(({ method, index }, position) => ({
		method,
		text: source.slice(index, starts[position + 1]?.index ?? source.length),
	}));
}

/** What is wrong with one route file for its module: unwrapped methods, and methods that never ask who is calling. */
function guardProblems(source, id, isPublic) {
	const askNames = isPublic ? ["checkHost"] : ["checkUser", "checkAuth"];
	const problems = [];
	for (const { method, text } of methodsOf(source)) {
		if (!new RegExp(`^export const ${method} = withModule(?:<[^(]*>)?\\(\\s*"${id}"`).test(text))
			problems.push(`${method} is not wrapped in withModule("${id}", ...)`);
		else if (!new RegExp(`\\b(?:${askNames.join("|")})\\(`).test(text))
			problems.push(`${method} never calls ${askNames[0]}`);
	}
	if (methodsOf(source).length === 0) problems.push("exports no method");
	return problems;
}

function routeFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return routeFiles(path);
		return entry.name === "route.ts" ? [path] : [];
	});
}

/** Route files under one `/api/...` prefix, which may sit inside another module's prefix (`/api/public/booking`). */
function routesUnder(prefix) {
	return routeFiles(join(root, "src/app", prefix));
}

const guardedRoutes = MODULE_MANIFESTS.flatMap((manifest) =>
	manifest.apiPrefixes.flatMap(({ prefix, public: isPublic }) =>
		routesUnder(prefix).map((file) => ({ id: manifest.id, file, isPublic: !!isPublic })),
	),
);

test("the scan finds the route files of all four modules", () => {
	const names = guardedRoutes.map(({ file }) => relative(join(root, "src/app/api"), file));
	for (const expected of [
		"calendar/events/route.ts",
		"calendar/events/[eventId]/route.ts",
		"booking/route.ts",
		"booking/settings/route.ts",
		"booking/[eventId]/route.ts",
		"public/booking/route.ts",
		"public/booking/[eventId]/route.ts",
		"templates/route.ts",
		"templates/[id]/route.ts",
		"import/jobs/route.ts",
		"import/jobs/[id]/route.ts",
		"import/imap/route.ts",
		"import/imap/folders/route.ts",
		"import/messages/route.ts",
	])
		assert.ok(names.includes(expected), `${expected} is not scanned`);
	assert.deepEqual(new Set(guardedRoutes.map(({ id }) => id)), new Set(["calendar", "booking", "templates", "import"]));
});

test("every method of every module route is wrapped in withModule and asks who is calling", () => {
	const problems = guardedRoutes.flatMap(({ id, file, isPublic }) =>
		guardProblems(readFileSync(file, "utf8"), id, isPublic).map((problem) => `${relative(root, file)}: ${problem}`),
	);
	assert.deepEqual(problems, []);
});

test("the export routes are never wrapped", () => {
	const exportRoutes = routeFiles(join(root, "src/app/api/export"));
	assert.ok(exportRoutes.length > 0);
	for (const file of exportRoutes) assert.doesNotMatch(readFileSync(file, "utf8"), /withModule/, relative(root, file));
});

test("the scan fails for an unwrapped method, a wrong module id and a missing check", () => {
	const wrapped = [
		'export const GET = withModule("calendar", async (request, { checkUser }) => {',
		"\tconst denied = await checkUser(user);",
		"\treturn denied ?? Response.json({});",
		"});",
		"",
	].join("\n");
	assert.deepEqual(guardProblems(wrapped, "calendar", false), []);
	const added = `${wrapped}\nexport async function POST(request) {\n\treturn Response.json({});\n}\n`;
	assert.deepEqual(guardProblems(added, "calendar", false), ['POST is not wrapped in withModule("calendar", ...)']);
	assert.deepEqual(guardProblems(wrapped, "booking", false), ['GET is not wrapped in withModule("booking", ...)']);
	assert.deepEqual(guardProblems(wrapped.replace("checkUser(user)", "user"), "calendar", false), [
		"GET never calls checkUser",
	]);
	assert.deepEqual(guardProblems(wrapped, "calendar", true), ["GET never calls checkHost"]);
	assert.deepEqual(guardProblems("export const dynamic = 'force-dynamic';", "calendar", false), ["exports no method"]);
	const generic = wrapped.replace('withModule("calendar"', 'withModule<Params>("calendar"');
	assert.deepEqual(guardProblems(generic, "calendar", false), []);
});

const migrationsDir = join(root, "drizzle/migrations");
const OWNER = { id: "owner", role: "admin", isPrimaryAdmin: true };
const MEMBER = { id: "member", role: "user", isPrimaryAdmin: false };

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1),
			('member', 'member@example.com', 'hash', 'Member', 'user', 0, 1);
	`);
	return db;
}

/** The same questions the server asks, answered from a real database through the real state functions. */
function checksFor(db) {
	const env = { DB: db };
	const viewer = (user) => ({ userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin });
	const known = { owner: OWNER, member: MEMBER };
	return {
		installEnabled: (id) => isModuleEnabled(env, id),
		userEnabled: (id, user) => isModuleEnabledFor(env, viewer(user), id),
		hostEnabled: (id, hostUserId) => isModuleEnabledFor(env, viewer(known[hostUserId]), id),
	};
}

/** A route that authenticates from the Authorization header the way a session route does, and counts its runs. */
function sessionRoute(checks, id) {
	const calls = { handler: 0 };
	const route = guardRoute(checks, id, async (request, { checkUser }) => {
		calls.handler++;
		const caller = request.headers.get("x-user");
		if (!caller) return Response.json({ error: "Unauthorized" }, { status: 401 });
		const denied = await checkUser(caller === "owner" ? OWNER : MEMBER);
		if (denied) return denied;
		return Response.json({ ok: true });
	});
	return { route, calls };
}

const call = (route, user) =>
	route(new Request("http://localhost/api/x", { headers: user ? { "x-user": user } : {} }), {
		params: Promise.resolve({}),
	});

async function readNotFound(response) {
	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Not found" });
}

test("install off answers 404 before authentication for every caller, and never runs the handler", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	const { route, calls } = sessionRoute(checksFor(db), "calendar");
	for (const user of [null, "owner", "member"]) await readNotFound(await call(route, user));
	assert.equal(calls.handler, 0);
});

test("a signed-out request to a module that is on still answers the route's own 401", async (t) => {
	const db = await database(t);
	const { route, calls } = sessionRoute(checksFor(db), "calendar");
	const response = await call(route, null);
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "Unauthorized" });
	assert.equal(calls.handler, 1);
	assert.equal((await call(route, "owner")).status, 200);
	assert.equal((await call(route, "member")).status, 200);
});

test("a restricted user answers 404 after authentication while others keep access", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'import', 0, 1)",
	);
	const { route, calls } = sessionRoute(checksFor(db), "import");
	await readNotFound(await call(route, "member"));
	assert.equal(calls.handler, 1);
	assert.equal((await call(route, "owner")).status, 200);
	// Not signed in: the handler's 401 comes first, so a restriction is not revealed to strangers.
	assert.equal((await call(route, null)).status, 401);
});

test("a restricted non-admin answers the route's own 403, and 404 only comes once role authorization passes", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'booking', 0, 1)",
	);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('restricted-admin', 'ra@example.com', 'hash', 'RA', 'admin', 0, 1)",
	);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u2', 'restricted-admin', 'booking', 0, 1)",
	);
	const users = { owner: OWNER, member: MEMBER, "restricted-admin": { id: "restricted-admin", role: "admin" } };
	// The order of src/app/api/booking/settings/route.ts: session, admin role, then checkUser.
	const route = guardRoute(checksFor(db), "booking", async (request, { checkUser }) => {
		const user = users[request.headers.get("x-user") ?? ""];
		if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
		if (user.role !== "admin") return Response.json({ error: "Only administrators" }, { status: 403 });
		return (await checkUser(user)) ?? Response.json({ ok: true });
	});
	assert.equal((await call(route, null)).status, 401);
	assert.equal((await call(route, "member")).status, 403);
	await readNotFound(await call(route, "restricted-admin"));
	assert.equal((await call(route, "owner")).status, 200);
	const off = await database(t);
	off.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'booking'");
	const offRoute = guardRoute(checksFor(off), "booking", async () =>
		Response.json({ error: "Unauthorized" }, { status: 401 }),
	);
	for (const user of [null, "member", "owner"]) await readNotFound(await call(offRoute, user));
});

test("no module route runs checkUser before its own role authorization", () => {
	const ROLE_CHECK = /role\s*!==?\s*["']admin["']|requireSessionAdmin|!isAdmin\(|!isPrimaryAdmin\(/;
	const offenders = [];
	for (const { file } of guardedRoutes)
		for (const { method, text } of methodsOf(readFileSync(file, "utf8"))) {
			const check = text.indexOf("checkUser(");
			const role = text.search(ROLE_CHECK);
			if (check !== -1 && role !== -1 && role > check) offenders.push(`${relative(root, file)} ${method}`);
		}
	assert.deepEqual(offenders, []);
	const settings = readFileSync(join(root, "src/app/api/booking/settings/route.ts"), "utf8");
	assert.ok(settings.search(ROLE_CHECK) !== -1 && settings.indexOf("checkUser(") > settings.search(ROLE_CHECK));
});

test("checkAuth folds the user check into the route's own auth result", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'import', 0, 1)",
	);
	const route = guardRoute(checksFor(db), "import", async (request, { checkAuth }) => {
		const caller = request.headers.get("x-user");
		const auth = await checkAuth(
			caller
				? { user: caller === "owner" ? OWNER : MEMBER, error: null }
				: { user: null, error: Response.json({ error: "Unauthorized" }, { status: 401 }) },
		);
		return auth.error ?? Response.json({ ok: true });
	});
	await readNotFound(await call(route, "member"));
	assert.equal((await call(route, "owner")).status, 200);
	assert.equal((await call(route, null)).status, 401);
});

test("the primary admin passes a module whose access row says restricted", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'owner', 'import', 0, 1)",
	);
	const { route } = sessionRoute(checksFor(db), "import");
	assert.equal((await call(route, "owner")).status, 200);
});

test("Booking routes answer 404 while Calendar is off, whatever Booking's own flag says", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'calendar'");
	assert.equal(db.db.prepare("SELECT enabled FROM module_settings WHERE module_id = 'booking'").get().enabled, 1);
	const { route, calls } = sessionRoute(checksFor(db), "booking");
	for (const user of [null, "owner", "member"]) await readNotFound(await call(route, user));
	assert.equal(calls.handler, 0);
});

test("a public route asks about the host, and a restricted host answers 404 without a session", async (t) => {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('u1', 'member', 'booking', 0, 1)",
	);
	const route = guardRoute(checksFor(db), "booking", async (request, { checkHost }) => {
		const denied = await checkHost(new URL(request.url).searchParams.get("host"));
		return denied ?? Response.json({ ok: true });
	});
	const ask = (host) => route(new Request(`http://localhost/api/public/booking?host=${host}`), {});
	assert.equal((await ask("owner")).status, 200);
	await readNotFound(await ask("member"));

	const off = await database(t);
	off.db.exec("UPDATE module_settings SET enabled = 0 WHERE module_id = 'booking'");
	const offRoute = guardRoute(checksFor(off), "booking", async () => Response.json({ ok: true }));
	await readNotFound(await offRoute(new Request("http://localhost/api/public/booking"), {}));
});

test("pageAccess keeps the sign-in redirect for a module that is on and hides one that is off", async () => {
	const checks = (install, user) => ({
		installEnabled: async () => install,
		userEnabled: async () => user,
		hostEnabled: async () => user,
	});
	assert.equal(await pageAccess(checks(false, true), "calendar", null), "off");
	assert.equal(await pageAccess(checks(false, true), "calendar", OWNER), "off");
	assert.equal(await pageAccess(checks(true, true), "calendar", null), "signed-out");
	assert.equal(await pageAccess(checks(true, false), "calendar", MEMBER), "restricted");
	assert.equal(await pageAccess(checks(true, true), "calendar", MEMBER), "open");
});

test("publicPageAccess decides from the install and the host, and does not look up a host when the module is off", async () => {
	let lookups = 0;
	const host = async () => (lookups++, "member");
	const checks = (install, allowed) => ({ installEnabled: async () => install, hostEnabled: async () => allowed });
	assert.equal(await publicPageAccess(checks(false, true), "booking", host), "off");
	assert.equal(lookups, 0);
	assert.equal(await publicPageAccess(checks(true, false), "booking", host), "restricted");
	assert.equal(await publicPageAccess(checks(true, true), "booking", host), "open");
	// An unknown host is left to the page's own unavailable message.
	assert.equal(await publicPageAccess(checks(true, false), "booking", async () => null), "open");
});

test("every module page tree has a gating layout", () => {
	const layout = (path) => readFileSync(join(root, path), "utf8");
	assert.match(layout("src/app/(calendar)/layout.tsx"), /requireModulePage\("calendar"\)/);
	assert.match(layout("src/app/(calendar)/layout.tsx"), /export const dynamic = "force-dynamic"/);
	assert.match(layout("src/app/(booking)/layout.tsx"), /requireModulePage\("booking"\)/);
	assert.match(layout("src/app/book/[userId]/layout.tsx"), /requirePublicModulePage\("booking"/);
	assert.match(layout("src/app/c/[username]/layout.tsx"), /requirePublicModulePage\("booking"/);
	assert.match(layout("src/app/(import)/layout.tsx"), /requireModulePage\("import"\)/);
	assert.ok(!existsSync(join(root, "src/app/(settings)/settings/export/layout.tsx")), "Export is never gated");
});

// AuthGuard renders nothing on the server, so next build streams a 200 before a not-found from inside it surfaces.
test("module page guards run in the outermost layout of a route group, above any shell", () => {
	const guarded = [];
	const walk = (dir) => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name) && /requireModulePage\(/.test(readFileSync(join(root, path), "utf8")))
				guarded.push(path);
		}
	};
	walk("src/app");
	assert.deepEqual(guarded.sort(), [
		"src/app/(booking)/layout.tsx",
		"src/app/(calendar)/layout.tsx",
		"src/app/(import)/layout.tsx",
	]);
});
