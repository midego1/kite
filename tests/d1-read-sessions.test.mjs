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
			export { fetchWithD1Session } from "./src/lib/d1-session.ts";
			export { runWithD1Session, currentD1Session } from "./src/lib/d1-session-context.ts";
			export { getEnv } from "./src/lib/cloudflare.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export { getMigrationStatus, applyPendingMigrations } from "./src/lib/migrations/service.ts";
			export { loadStorageConfig, clearStorageConfigCache } from "./src/lib/storage/config.ts";
			export { issueRecoveryCodes, consumeRecoveryCode, countUnusedRecoveryCodes } from "./src/lib/auth/recovery-codes.ts";
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
	D1_PRIMARY_READ_HEADER,
	readD1Bookmark,
	isValidD1Bookmark,
	compareD1Bookmarks,
	incomingD1Bookmark,
	d1SessionMode,
	d1SessionConstraint,
	openD1Session,
	sessionDatabase,
	primaryDatabase,
	databaseKey,
	notePrimaryWrite,
	withD1Session,
	d1BookmarkCookie,
	withD1BookmarkCookie,
	fetchWithD1Session,
	runWithD1Session,
	currentD1Session,
	getEnv,
	SqliteDatabase,
	applyMigrations,
	createSession,
	getUserFromSession,
	getMigrationStatus,
	applyPendingMigrations,
	loadStorageConfig,
	clearStorageConfigCache,
	issueRecoveryCodes,
	consumeRecoveryCode,
	countUnusedRecoveryCodes,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const COOKIE = "__Host-kite_d1_bm";
const OLD = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";
const NEW = "00000085-0000024d-00000001-00000000000000000000000000000000";
const NEWER = "00000086-00000000-00000000-ffffffffffffffffffffffffffffffff";

/** A D1 session stand-in: statements report `meta`, `run` can be told to fail, the bookmark is settable. */
function fakeSession(bookmark = NEW, { fail, changed = false } = {}) {
	const session = {
		bookmark,
		prepared: [],
		prepare(query) {
			session.prepared.push(query);
			const statement = {
				params: [],
				bind(...values) {
					return { ...statement, params: values };
				},
				async run() {
					if (fail) throw fail;
					return { results: [], meta: { changed_db: changed, changes: changed ? 1 : 0 } };
				},
				async all() {
					if (fail) throw fail;
					return { results: [{ query }], meta: { changed_db: false } };
				},
				async raw() {
					if (fail) throw fail;
					return [[query]];
				},
				async first() {
					if (fail) throw fail;
					return { query };
				},
			};
			return statement;
		},
		async batch(statements) {
			if (fail) throw fail;
			return statements.map(() => ({ results: [], meta: { changed_db: changed } }));
		},
		getBookmark: () => session.bookmark,
	};
	return session;
}

/** A D1 binding stand-in recording the `withSession` constraints; the raw binding must not be queried. */
function fakeBinding(session = fakeSession(), { refuse } = {}) {
	const binding = {
		constraints: [],
		sessions: [],
		withSession(constraint) {
			binding.constraints.push(constraint);
			if (refuse && refuse(constraint)) throw new Error("D1_ERROR: invalid bookmark");
			const next = binding.sessions.length === 0 ? session : fakeSession(NEWER);
			binding.sessions.push(next);
			return next;
		},
		prepare: () => {
			throw new Error("the raw binding was used");
		},
		exec: async () => ({ count: 0, duration: 0 }),
		dump: async () => new ArrayBuffer(0),
	};
	return binding;
}

const url = (path) => `https://mail.example.com${path}`;
const get = (path, headers = {}) => new Request(url(path), { headers });
const post = (path, headers = {}) => new Request(url(path), { method: "POST", headers });
const withBookmark = (value) => ({ cookie: `ep_session=s; ${COOKIE}=${encodeURIComponent(value)}; x=1` });
const outcome = (bookmark, extra = {}) => ({
	bookmark,
	wrote: false,
	primaryWrite: false,
	resetCookie: false,
	...extra,
});

test("the cookie is __Host- prefixed over https and plain on http development", () => {
	assert.equal(readD1Bookmark(get("/", withBookmark(OLD))), OLD);
	assert.equal(readD1Bookmark(get("/", { cookie: `kite_d1_bm=${OLD}` })), undefined);
	const plain = new Request("http://localhost:3000/", { headers: { cookie: `${COOKIE}=x; kite_d1_bm=${OLD}` } });
	assert.equal(readD1Bookmark(plain), OLD);
	assert.equal(readD1Bookmark(get("/")), undefined);
	assert.equal(readD1Bookmark(get("/", { cookie: `${COOKIE}=` })), undefined);
});

test("bookmarks are validated and ordered by their counter groups, not the hash", () => {
	assert.equal(isValidD1Bookmark(OLD), true);
	for (const bad of ["", "garbage", "first-unconstrained", "<script>", "00000085", `${OLD}-`, "a".repeat(200)]) {
		assert.equal(isValidD1Bookmark(bad), false, bad);
	}
	assert.equal(compareD1Bookmarks(NEW, OLD), 1);
	assert.equal(compareD1Bookmarks(OLD, NEW), -1);
	assert.equal(compareD1Bookmarks(NEWER, NEW), 1);
	assert.equal(compareD1Bookmarks(OLD, "00000085-0000024c-00004c6d-00000000000000000000000000000000"), 0);
	assert.equal(compareD1Bookmarks(OLD, "0001-0002"), null);
	assert.equal(compareD1Bookmarks(OLD, "garbage"), null);
});

test("incoming cookies are a bookmark, the primary marker, malformed or absent", () => {
	assert.deepEqual(incomingD1Bookmark(get("/", withBookmark(OLD))), { kind: "bookmark", value: OLD });
	assert.deepEqual(incomingD1Bookmark(get("/", withBookmark("first-primary"))), { kind: "primary" });
	assert.deepEqual(incomingD1Bookmark(get("/", withBookmark("not a bookmark"))), { kind: "invalid" });
	assert.deepEqual(incomingD1Bookmark(get("/", { cookie: `${COOKIE}=%E0%A4%A` })), { kind: "invalid" });
	assert.deepEqual(incomingD1Bookmark(get("/")), { kind: "none" });
});

test("browser pages and APIs use a replica session", () => {
	for (const path of ["/", "/inbox", "/api/messages", "/api/drive/items", "/settings/profile", "/drive", "/booking"]) {
		assert.equal(d1SessionMode(get(path)), "replica", path);
	}
});

test("sign-in, setup, the migration runner and realtime refetches start on the primary", () => {
	for (const path of [
		"/api/auth/login",
		"/api/auth/password-reset",
		"/api/setup/prepare",
		"/api/seed",
		"/api/migrations/pending",
		"/api/admin/migrations",
	]) {
		assert.equal(d1SessionMode(post(path)), "primary", path);
		assert.equal(d1SessionConstraint(post(path, withBookmark(OLD)), "primary"), "first-primary", path);
	}
	assert.equal(d1SessionMode(get("/api/messages", { [D1_PRIMARY_READ_HEADER]: "1" })), "primary");
});

test("webhooks, public pages, bearer APIs and the realtime upgrade run without a session", () => {
	for (const path of [
		"/api/inbound",
		"/api/inbound/resend",
		"/api/inbound/ses/abc",
		"/d/token",
		"/api/public/drive/token",
		"/api/public/booking/x",
		"/api/shared-files/abc",
		"/book/user_1",
		"/book/user_1/event_2",
		"/c/someone",
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

test("where a session starts", () => {
	assert.equal(d1SessionConstraint(get("/inbox", withBookmark(OLD)), "replica"), OLD);
	assert.equal(d1SessionConstraint(post("/api/send", withBookmark(OLD)), "replica"), OLD);
	assert.equal(d1SessionConstraint(get("/inbox", withBookmark("first-primary")), "replica"), "first-primary");
	assert.equal(d1SessionConstraint(get("/inbox", withBookmark("junk")), "replica"), "first-unconstrained");
	assert.equal(d1SessionConstraint(post("/api/send", withBookmark("junk")), "replica"), "first-primary");
	assert.equal(d1SessionConstraint(get("/inbox"), "replica"), "first-unconstrained");
	assert.equal(d1SessionConstraint(post("/api/send"), "replica"), "first-primary");
});

test("openD1Session wraps the binding and keeps the raw binding reachable", async () => {
	const session = fakeSession();
	const binding = fakeBinding(session);
	const database = openD1Session({ DB: binding }, get("/inbox", withBookmark(OLD)));
	assert.deepEqual(binding.constraints, [OLD]);
	assert.deepEqual(await database.prepare("SELECT ?").bind(1).all(), {
		results: [{ query: "SELECT ?" }],
		meta: { changed_db: false },
	});
	assert.deepEqual(await database.prepare("SELECT 2").raw(), [["SELECT 2"]]);
	assert.deepEqual(await database.prepare("SELECT 3").first(), { query: "SELECT 3" });
	assert.deepEqual(session.prepared, ["SELECT ?", "SELECT 2", "SELECT 3"]);
	assert.equal(database.getBookmark(), NEW);
	assert.equal(primaryDatabase(database), binding);
	assert.equal(primaryDatabase(binding), binding);
	assert.equal(primaryDatabase(undefined), undefined);
	assert.equal(databaseKey(database), binding);
	// A session database is never wrapped twice.
	assert.equal(openD1Session({ DB: database }, get("/inbox")), null);
});

test("openD1Session is a no-op on Node, for mode off and for bindings without sessions", () => {
	const binding = fakeBinding();
	assert.equal(openD1Session({ DB: binding, KITE_RUNTIME: "node" }, get("/inbox")), null);
	assert.equal(openD1Session({ DB: binding }, get("/api/inbound/resend")), null);
	assert.deepEqual(binding.constraints, []);
	assert.equal(openD1Session({ DB: { prepare() {} } }, get("/inbox")), null);
	assert.equal(openD1Session({}, get("/inbox")), null);
	assert.equal(openD1Session({ DB: { withSession: () => null } }, get("/inbox")), null);
	assert.equal(openD1Session({ DB: { withSession: () => ({}) } }, get("/inbox")), null);
});

test("a malformed cookie never reaches withSession and is replaced", async () => {
	const binding = fakeBinding();
	const request = get("/inbox", withBookmark("garbage<>"));
	const database = openD1Session({ DB: binding }, request);
	assert.deepEqual(binding.constraints, ["first-unconstrained"]);
	await database.prepare("SELECT 1").all();
	const response = withD1BookmarkCookie(request, new Response("ok"), database);
	assert.match(response.headers.get("set-cookie"), new RegExp(`^${COOKIE}=${NEW};`));
	// Without a bookmark to store, the bad cookie is cleared.
	const idle = openD1Session({ DB: fakeBinding(fakeSession(null)) }, request);
	assert.match(withD1BookmarkCookie(request, new Response("ok"), idle).headers.get("set-cookie"), /Max-Age=0/);
});

test("a bookmark withSession refuses falls back to first-primary and replaces the cookie", () => {
	const binding = fakeBinding(fakeSession(NEWER), { refuse: (constraint) => constraint === OLD });
	const request = get("/inbox", withBookmark(OLD));
	const database = openD1Session({ DB: binding }, request);
	assert.deepEqual(binding.constraints, [OLD, "first-primary"]);
	const response = withD1BookmarkCookie(request, new Response("ok"), database);
	assert.match(response.headers.get("set-cookie"), new RegExp(`^${COOKIE}=${NEWER};`));
});

test("a bookmark refused on the first query restarts the session on the primary once", async () => {
	const refusing = fakeSession(OLD, { fail: new Error("D1_ERROR: bookmark is not valid") });
	const binding = fakeBinding(refusing);
	const request = get("/inbox", withBookmark(OLD));
	const database = openD1Session({ DB: binding }, request);
	const result = await database.prepare("SELECT 1").all();
	assert.deepEqual(result.results, [{ query: "SELECT 1" }]);
	assert.deepEqual(binding.constraints, [OLD, "first-primary"]);
	assert.match(withD1BookmarkCookie(request, new Response("ok"), database).headers.get("set-cookie"), /=00000086-/);

	// Other errors, and a refusal without a browser bookmark, are not retried.
	const other = openD1Session({ DB: fakeBinding(fakeSession(OLD, { fail: new Error("no such table") })) }, request);
	await assert.rejects(other.prepare("SELECT 1").run(), /no such table/);
	const unanchored = openD1Session({ DB: fakeBinding(refusing) }, get("/inbox"));
	await assert.rejects(unanchored.prepare("SELECT 1").run(), /bookmark/);
});

test("batch runs the session's statements and reports writes", async () => {
	const session = fakeSession(NEW, { changed: true });
	const database = sessionDatabase(fakeBinding(session), session);
	const results = await database.batch([database.prepare("UPDATE a").bind(1), database.prepare("UPDATE b")]);
	assert.equal(results.length, 2);
	assert.deepEqual(session.prepared, ["UPDATE a", "UPDATE b"]);
	// The write makes a bookmark that cannot be ordered against the browser's worth storing, even on a GET.
	const request = get("/api/mailboxes", withBookmark("0001-0002"));
	assert.equal(incomingD1Bookmark(request).kind, "bookmark");
	assert.match(withD1BookmarkCookie(request, new Response("ok"), database).headers.get("set-cookie"), /=00000085-/);
});

test("exec, dump and withSession on the session database go to the primary binding", async () => {
	const session = fakeSession();
	const binding = fakeBinding(session);
	const database = sessionDatabase(binding, session);
	assert.deepEqual(await database.exec("PRAGMA x"), { count: 0, duration: 0 });
	assert.equal((await database.dump()).byteLength, 0);
	assert.equal(database.withSession("first-primary"), session);
	assert.deepEqual(binding.constraints, ["first-primary"]);
});

test("withD1Session shadows only DB and keeps every proxy trap consistent", () => {
	const binding = fakeBinding();
	const env = {};
	Object.defineProperty(env, "DB", { value: binding, enumerable: false });
	Object.defineProperty(env, "BUCKET", { value: "bucket", enumerable: false });
	const database = sessionDatabase(binding, fakeSession());
	const proxied = withD1Session(env, database);
	assert.equal(proxied.DB, database);
	assert.equal(proxied.BUCKET, "bucket");
	assert.equal(env.DB, binding);
	assert.equal(withD1Session(env, database), proxied, "cached per env and session");
	assert.equal("DB" in proxied, true);
	assert.equal("BUCKET" in proxied, true);
	assert.equal("QUEUE" in proxied, false);
	assert.deepEqual(Reflect.ownKeys(proxied).sort(), ["BUCKET", "DB"]);
	assert.equal(Object.getOwnPropertyDescriptor(proxied, "DB").value, database);
	assert.equal(Object.getOwnPropertyDescriptor(proxied, "BUCKET").value, "bucket");
	assert.equal(Object.getOwnPropertyDescriptor(proxied, "QUEUE"), undefined);
	proxied.APP_URL = "https://mail.example.com";
	assert.equal(proxied.APP_URL, "https://mail.example.com");
	assert.equal(Reflect.set(proxied, "DB", binding), false);
	assert.equal(proxied.DB, database);
});

test("the bookmark cookie is HttpOnly, SameSite=Lax, path / and Secure over https", () => {
	assert.equal(
		d1BookmarkCookie(get("/inbox"), outcome(NEW)),
		`${COOKIE}=${NEW}; Path=/; HttpOnly; SameSite=Lax; Secure`,
	);
	assert.equal(
		d1BookmarkCookie(new Request("http://localhost:3000/inbox"), outcome(NEW)),
		`kite_d1_bm=${NEW}; Path=/; HttpOnly; SameSite=Lax`,
	);
	assert.equal(d1BookmarkCookie(get("/inbox"), outcome(null)), null);
});

test("a bookmark is stored only when it is newer than the browser's, whatever the method", () => {
	assert.equal(d1BookmarkCookie(get("/inbox", withBookmark(NEW)), outcome(OLD)), null);
	assert.equal(d1BookmarkCookie(post("/api/send", withBookmark(NEW)), outcome(OLD, { wrote: true })), null);
	assert.equal(d1BookmarkCookie(get("/inbox", withBookmark(NEW)), outcome(NEW)), null);
	assert.match(d1BookmarkCookie(get("/api/mailboxes", withBookmark(OLD)), outcome(NEW)), /=00000085-0000024d/);
	assert.match(d1BookmarkCookie(post("/api/send", withBookmark(OLD)), outcome(NEWER)), /=00000086-/);
	assert.match(d1BookmarkCookie(get("/inbox"), outcome(NEW)), /=00000085-0000024d/);
	// A bookmark that cannot be ordered against the browser's is stored only after a write.
	assert.equal(d1BookmarkCookie(get("/inbox", withBookmark("0001-0002")), outcome(NEW)), null);
	assert.match(d1BookmarkCookie(get("/inbox", withBookmark("0001-0002")), outcome(NEW, { wrote: true })), /=0000/);
	// The primary marker gives way to any real bookmark.
	assert.match(d1BookmarkCookie(get("/inbox", withBookmark("first-primary")), outcome(OLD)), /=00000085-0000024c/);
});

test("a write to the raw primary sends the browser's next request to the primary", () => {
	const session = fakeSession(NEW);
	const database = sessionDatabase(fakeBinding(session), session);
	notePrimaryWrite(database);
	notePrimaryWrite(undefined);
	const response = withD1BookmarkCookie(post("/api/admin/migrations"), new Response("ok"), database);
	assert.match(response.headers.get("set-cookie"), new RegExp(`^${COOKIE}=first-primary;`));
	assert.equal(d1SessionConstraint(get("/inbox", withBookmark("first-primary")), "replica"), "first-primary");
});

test("withD1BookmarkCookie keeps existing cookies and leaves upgrades alone", () => {
	const session = fakeSession(NEW);
	const database = sessionDatabase(fakeBinding(session), session);
	const original = new Response("body", { status: 201, headers: { "set-cookie": "ep_session=s; Path=/" } });
	const response = withD1BookmarkCookie(post("/api/send"), original, database);
	assert.equal(response.status, 201);
	assert.deepEqual(response.headers.getSetCookie(), [
		"ep_session=s; Path=/",
		`${COOKIE}=${NEW}; Path=/; HttpOnly; SameSite=Lax; Secure`,
	]);
	const untouched = new Response("body");
	assert.equal(withD1BookmarkCookie(post("/api/send"), untouched, null), untouched);
	const upgrade = { status: 101, webSocket: {}, headers: new Headers() };
	assert.equal(withD1BookmarkCookie(get("/inbox"), upgrade, database), upgrade);
});

test("getEnv() serves DB from the request's session on Workers only", async () => {
	const binding = fakeBinding();
	globalThis.__testWorkersEnv = { DB: binding, APP_URL: "https://mail.example.com" };
	try {
		const database = sessionDatabase(binding, fakeSession());
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

test("fetchWithD1Session runs the handler on the session and stores its bookmark", async () => {
	const binding = fakeBinding(fakeSession(NEW));
	const env = { DB: binding, APP_URL: "https://mail.example.com" };
	globalThis.__testWorkersEnv = env;
	try {
		const response = await fetchWithD1Session(get("/inbox", withBookmark(OLD)), env, async (_request, sessionEnv) => {
			assert.equal(primaryDatabase(sessionEnv.DB), binding);
			assert.equal(getEnv().DB, sessionEnv.DB);
			await getEnv().DB.prepare("SELECT 1").all();
			return new Response("page");
		});
		assert.equal(await response.text(), "page");
		assert.deepEqual(binding.constraints, [OLD]);
		assert.match(response.headers.get("set-cookie"), new RegExp(`^${COOKIE}=${NEW};`));

		const inbound = await fetchWithD1Session(post("/api/inbound"), env, async (_request, rawEnv) => {
			assert.equal(rawEnv, env);
			assert.equal(getEnv().DB, binding);
			return new Response("stored");
		});
		assert.equal(inbound.headers.get("set-cookie"), null);
		assert.deepEqual(binding.constraints, [OLD]);
	} finally {
		delete globalThis.__testWorkersEnv;
	}
});

test("two concurrent requests each see their own session", async () => {
	globalThis.__testWorkersEnv = {};
	try {
		const first = fakeBinding(fakeSession(OLD));
		const second = fakeBinding(fakeSession(NEW));
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		const handler = async (_request, sessionEnv) => {
			await gate;
			assert.equal(getEnv().DB, sessionEnv.DB);
			return new Response(getEnv().DB.getBookmark());
		};
		const a = fetchWithD1Session(get("/inbox"), { DB: first }, handler);
		const b = fetchWithD1Session(get("/inbox"), { DB: second }, handler);
		release();
		const [responseA, responseB] = await Promise.all([a, b]);
		assert.equal(await responseA.text(), OLD);
		assert.equal(await responseB.text(), NEW);
	} finally {
		delete globalThis.__testWorkersEnv;
	}
});

/** A real migrated database. */
async function migratedDatabase() {
	const sqlite = new SqliteDatabase(":memory:");
	await applyMigrations(sqlite, join(root, "drizzle", "migrations"));
	return sqlite;
}

/** A session over a real database whose queries are counted. */
function countingSession(sqlite) {
	const session = {
		queries: 0,
		prepare(query) {
			session.queries += 1;
			return sqlite.prepare(query);
		},
		batch(statements) {
			session.queries += 1;
			return sqlite.batch(statements);
		},
		getBookmark: () => null,
	};
	return session;
}

test("isolate caches over the database are shared by every request's session", async () => {
	const sqlite = await migratedDatabase();
	clearStorageConfigCache();
	const firstSession = countingSession(sqlite);
	const secondSession = countingSession(sqlite);
	const first = sessionDatabase(sqlite, firstSession);
	const second = sessionDatabase(sqlite, secondSession);
	assert.equal(databaseKey(first), databaseKey(second));
	const config = await loadStorageConfig({ DB: first });
	assert.ok(firstSession.queries > 0);
	assert.equal(await loadStorageConfig({ DB: second }), config);
	assert.equal(secondSession.queries, 0, "the second request's session reused the cached config");
	clearStorageConfigCache();
});

test("authentication and the migration status read the primary, not the session", async () => {
	const sqlite = await migratedDatabase();
	await sqlite
		.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind("user_1", "owner@example.com", "x", "Owner", "admin", Date.now())
		.run();
	const token = await createSession({ DB: sqlite }, "user_1");
	// A lagging replica: every query on the session fails, so only the primary can answer.
	const database = sessionDatabase(sqlite, fakeSession(null, { fail: new Error("read a replica") }));
	const user = await getUserFromSession({ DB: database }, token);
	assert.equal(user?.id, "user_1");
	const status = await getMigrationStatus(database);
	assert.deepEqual(status.pending, []);
});

test("applying migrations through a session marks the response for the primary", async () => {
	const empty = new SqliteDatabase(":memory:");
	const session = fakeSession(NEW);
	const database = sessionDatabase(empty, session);
	const result = await applyPendingMigrations(database);
	assert.ok(result.applied.length > 0);
	assert.deepEqual(session.prepared, [], "the runner never used the session");
	const response = withD1BookmarkCookie(post("/api/admin/migrations"), new Response("ok"), database);
	assert.match(response.headers.get("set-cookie"), /=first-primary;/);
});

test("a recovery code is burnt by one conditional update, so it works once", async () => {
	const sqlite = await migratedDatabase();
	await sqlite
		.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind("user_2", "second@example.com", "x", "Second", "user", Date.now())
		.run();
	const env = { DB: sqlite };
	const [code] = await issueRecoveryCodes(env, "user_2");
	const before = await countUnusedRecoveryCodes(env, "user_2");
	const results = await Promise.all([
		consumeRecoveryCode(env, "user_2", code),
		consumeRecoveryCode(env, "user_2", code),
	]);
	assert.deepEqual(results.sort(), [false, true]);
	assert.equal(await consumeRecoveryCode(env, "user_2", code), false);
	assert.equal(await consumeRecoveryCode(env, "user_2", "not-a-code"), false);
	assert.equal(await countUnusedRecoveryCodes(env, "user_2"), before - 1);
});
