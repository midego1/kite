import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-d1-sessions-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
// `getEnv()` reads `env` from `cloudflare:workers`; this stand-in forwards to whatever the test puts on globalThis.
const workersStub = join(directory, "cloudflare-workers-stub.ts");
writeFileSync(
	workersStub,
	"export const env = new Proxy({}, { get: (_target, property) => globalThis.__testWorkersEnv?.[property] });\n",
);
await build({
	stdin: {
		contents: `
			export * from "./src/lib/d1-session-utils.ts";
			export { runWithD1Session, currentD1Session } from "./src/lib/d1-session-context.ts";
			export { getEnv } from "./src/lib/cloudflare.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export { getMigrationStatus } from "./src/lib/migrations/service.ts";
		`,
		resolveDir: root,
		sourcefile: "d1-sessions-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": workersStub },
	logLevel: "silent",
});
const {
	D1_BOOKMARK_COOKIE,
	readD1Bookmark,
	d1SessionMode,
	d1SessionConstraint,
	openD1Session,
	sessionDatabase,
	primaryDatabase,
	withD1Session,
	d1BookmarkCookie,
	withD1BookmarkCookie,
	runWithD1Session,
	currentD1Session,
	getEnv,
	SqliteDatabase,
	applyMigrations,
	createSession,
	getUserFromSession,
	getMigrationStatus,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** A D1 binding stand-in recording the `withSession` constraints; its session reports `bookmark`. */
function fakeBinding(bookmark = "bm-1") {
	const session = {
		prepared: [],
		prepare(query) {
			this.prepared.push(query);
			return { query };
		},
		batch: async (statements) => statements.map(() => ({ results: [] })),
		getBookmark: () => bookmark,
	};
	const binding = {
		constraints: [],
		withSession(constraint) {
			this.constraints.push(constraint);
			return session;
		},
		prepare: () => {
			throw new Error("the raw binding was used");
		},
		exec: async () => ({ count: 0, duration: 0 }),
		dump: async () => new ArrayBuffer(0),
	};
	return { binding, session };
}

const url = (path) => `https://mail.example.com${path}`;
const get = (path, headers = {}) => new Request(url(path), { headers });
const post = (path, headers = {}) => new Request(url(path), { method: "POST", headers });
const withBookmark = (value) => ({ cookie: `ep_session=s; ${D1_BOOKMARK_COOKIE}=${encodeURIComponent(value)}; x=1` });

test("readD1Bookmark reads and decodes the bookmark cookie", () => {
	assert.equal(readD1Bookmark(get("/", withBookmark("bm:a/b+c"))), "bm:a/b+c");
	assert.equal(readD1Bookmark(get("/")), undefined);
	assert.equal(readD1Bookmark(get("/", { cookie: "a=1; b=2" })), undefined);
	assert.equal(readD1Bookmark(get("/", { cookie: `${D1_BOOKMARK_COOKIE}=` })), undefined);
	assert.equal(readD1Bookmark(get("/", { cookie: `${D1_BOOKMARK_COOKIE}=%E0%A4%A` })), undefined);
});

test("browser pages and APIs use a replica session", () => {
	for (const path of ["/", "/inbox", "/api/messages", "/api/drive/items", "/settings/profile", "/drive"]) {
		assert.equal(d1SessionMode(get(path)), "replica", path);
	}
});

test("sign-in, setup and the migration runner start on the primary", () => {
	for (const path of [
		"/api/auth/login",
		"/api/auth/password-reset",
		"/api/setup/prepare",
		"/api/seed",
		"/api/migrations/pending",
		"/api/admin/migrations",
	]) {
		assert.equal(d1SessionMode(post(path)), "primary", path);
		assert.equal(d1SessionConstraint(post(path, withBookmark("bm")), "primary"), "first-primary", path);
	}
});

test("webhooks, public links, bearer APIs and the realtime upgrade run without a session", () => {
	for (const path of [
		"/api/inbound",
		"/api/inbound/resend",
		"/api/inbound/ses/abc",
		"/d/token",
		"/api/public/drive/token",
		"/api/public/booking/x",
		"/api/remote-images/proxy",
		"/api/v1/messages",
		"/api/oauth/token",
		"/jmap/api",
		"/.well-known/jmap",
		"/mcp",
		"/api/realtime",
	]) {
		assert.equal(d1SessionMode(get(path)), "off", path);
	}
	assert.equal(d1SessionMode(get("/api/messages", { authorization: "Bearer key" })), "off");
});

test("a read resumes from the bookmark, a first visit starts anywhere, a write without one on the primary", () => {
	assert.equal(d1SessionConstraint(get("/inbox", withBookmark("bm-prev")), "replica"), "bm-prev");
	assert.equal(d1SessionConstraint(post("/api/send", withBookmark("bm-prev")), "replica"), "bm-prev");
	assert.equal(d1SessionConstraint(get("/inbox"), "replica"), "first-unconstrained");
	assert.equal(d1SessionConstraint(post("/api/send"), "replica"), "first-primary");
});

test("openD1Session wraps the binding and keeps the raw binding reachable", () => {
	const { binding, session } = fakeBinding();
	const database = openD1Session({ DB: binding }, get("/inbox", withBookmark("bm-prev")));
	assert.deepEqual(binding.constraints, ["bm-prev"]);
	database.prepare("SELECT 1");
	assert.deepEqual(session.prepared, ["SELECT 1"]);
	assert.equal(database.getBookmark(), "bm-1");
	assert.equal(primaryDatabase(database), binding);
	assert.equal(primaryDatabase(binding), binding);
	assert.equal(primaryDatabase(undefined), undefined);
	// A session database is never wrapped twice.
	assert.equal(openD1Session({ DB: database }, get("/inbox")), null);
});

test("openD1Session is a no-op on Node, for mode off and for bindings without sessions", () => {
	const { binding } = fakeBinding();
	assert.equal(openD1Session({ DB: binding, KITE_RUNTIME: "node" }, get("/inbox")), null);
	assert.equal(openD1Session({ DB: binding }, get("/api/inbound/resend")), null);
	assert.deepEqual(binding.constraints, []);
	assert.equal(openD1Session({ DB: { prepare() {} } }, get("/inbox")), null);
	assert.equal(openD1Session({}, get("/inbox")), null);
});

test("withD1Session shadows only DB and leaves non-enumerable, non-configurable bindings reachable", () => {
	const { binding, session } = fakeBinding();
	const env = Object.create(null);
	Object.defineProperty(env, "DB", { value: binding, enumerable: false });
	Object.defineProperty(env, "BUCKET", { value: "bucket", enumerable: false });
	const database = sessionDatabase(binding, session);
	const proxied = withD1Session(env, database);
	assert.equal(proxied.DB, database);
	assert.equal(proxied.BUCKET, "bucket");
	assert.equal(env.DB, binding);
	assert.equal(withD1Session(env, database), proxied, "cached per env and session");
});

test("the bookmark cookie is HttpOnly, SameSite=Lax, path / and Secure over https", () => {
	const cookie = d1BookmarkCookie(get("/inbox"), "bm:new/1");
	assert.equal(
		cookie,
		`${D1_BOOKMARK_COOKIE}=${encodeURIComponent("bm:new/1")}; Path=/; HttpOnly; SameSite=Lax; Secure`,
	);
	assert.doesNotMatch(d1BookmarkCookie(new Request("http://localhost:3000/inbox"), "bm"), /Secure/);
	assert.equal(d1BookmarkCookie(get("/inbox"), null), null);
});

test("a read never moves an existing bookmark; writes and first visits store it", () => {
	assert.equal(d1BookmarkCookie(get("/inbox", withBookmark("newer")), "older"), null);
	assert.equal(d1BookmarkCookie(new Request(url("/inbox"), { method: "HEAD", headers: withBookmark("x") }), "y"), null);
	assert.match(d1BookmarkCookie(post("/api/send", withBookmark("old")), "after-write"), /=after-write;/);
	assert.match(d1BookmarkCookie(get("/inbox"), "first"), /=first;/);
});

test("withD1BookmarkCookie appends the cookie and keeps existing ones", () => {
	const { binding, session } = fakeBinding("bm-new");
	const database = sessionDatabase(binding, session);
	const original = new Response("body", { status: 201, headers: { "set-cookie": "ep_session=s; Path=/" } });
	const response = withD1BookmarkCookie(post("/api/send"), original, database);
	assert.equal(response.status, 201);
	assert.deepEqual(response.headers.getSetCookie(), [
		"ep_session=s; Path=/",
		`${D1_BOOKMARK_COOKIE}=bm-new; Path=/; HttpOnly; SameSite=Lax; Secure`,
	]);
	const untouched = new Response("body");
	assert.equal(withD1BookmarkCookie(post("/api/send"), untouched, null), untouched);
	assert.equal(
		withD1BookmarkCookie(post("/api/send"), untouched, sessionDatabase(binding, fakeBinding(null).session)),
		untouched,
	);
});

test("getEnv() serves DB from the request's session on Workers only", async () => {
	const { binding, session } = fakeBinding();
	globalThis.__testWorkersEnv = { DB: binding, APP_URL: "https://mail.example.com" };
	try {
		const database = sessionDatabase(binding, session);
		assert.equal(getEnv().DB, binding);
		const seen = await runWithD1Session(database, async () => {
			await Promise.resolve();
			return { db: getEnv().DB, appUrl: getEnv().APP_URL, current: currentD1Session() };
		});
		assert.equal(seen.db, database);
		assert.equal(seen.appUrl, "https://mail.example.com");
		assert.equal(seen.current, database);
		assert.equal(currentD1Session(), undefined);
		assert.equal(
			runWithD1Session(null, () => currentD1Session()),
			undefined,
		);

		const nodeDb = { prepare() {} };
		globalThis.__kiteNodeEnv = { DB: nodeDb, KITE_RUNTIME: "node" };
		assert.equal(await runWithD1Session(database, () => getEnv().DB), nodeDb);
	} finally {
		delete globalThis.__testWorkersEnv;
		delete globalThis.__kiteNodeEnv;
	}
});

test("authentication and the migration status read the primary, not the session", async () => {
	const sqlite = new SqliteDatabase(":memory:");
	await applyMigrations(sqlite, join(root, "drizzle", "migrations"));
	await sqlite
		.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind("user_1", "owner@example.com", "x", "Owner", "admin", Date.now())
		.run();
	const token = await createSession({ DB: sqlite }, "user_1");
	// A lagging replica: every query on the session fails, so only the primary can answer.
	const replica = {
		prepare: () => {
			throw new Error("read a replica");
		},
		batch: async () => {
			throw new Error("read a replica");
		},
		getBookmark: () => null,
	};
	const database = sessionDatabase(sqlite, replica);
	const user = await getUserFromSession({ DB: database }, token);
	assert.equal(user?.id, "user_1");
	const status = await getMigrationStatus(database);
	assert.deepEqual(status.pending, []);
});
