/**
 * D1 read-replica sessions for the fetch handler (ported from upstream Mailflare #268).
 *
 * Every request used to run all its queries on `env.DB` directly, so D1 sent every read to the primary. A request
 * now runs on a D1 session (`env.DB.withSession()`) anchored at the bookmark the browser's last response left in
 * the `kite_d1_bm` cookie, so reads may be served by a read replica while the browser still sees its own writes
 * (sequential consistency). With read replication off in Cloudflare a session behaves exactly like the binding.
 *
 * Only the D1 binding is wrapped, through a proxy (Worker bindings are not enumerable, so the env cannot be
 * spread), and before `withStorage`, so every `getEnv()` caller gets it. The queue, email and scheduled handlers,
 * the realtime Durable Object and the Node runtime keep the raw binding (the primary).
 */

/** @public Exercised by the unit tests. */
export const D1_BOOKMARK_COOKIE = "kite_d1_bm";

/**
 * `off`: no session and no cookie, the raw binding answers. `primary`: a session whose first query goes to the
 * primary, for paths whose reads must be current. `replica`: a session anchored at the browser's bookmark.
 */
type D1SessionMode = "off" | "primary" | "replica";

/**
 * Surfaces without a browser that keeps our cookies, or that promise to set none: webhooks and inbound mail, public
 * Drive links (no cookies, `no-store`), the remote-image proxy, bearer-token APIs (REST, JMAP, MCP, OAuth clients),
 * which cannot carry a bookmark between requests and would otherwise miss their own writes, and the realtime
 * upgrade, which hands the connection to the Durable Object.
 */
const OFF_PREFIXES = [
	"/api/inbound",
	"/api/public/",
	"/d/",
	"/api/remote-images",
	"/api/v1/",
	"/api/oauth/",
	"/jmap",
	"/.well-known/",
	"/mcp",
	"/api/realtime",
];

/** Sign-in, single-use tokens, first-run setup and the migration status and runner read the primary. */
const PRIMARY_PREFIXES = ["/api/auth/", "/api/setup", "/api/seed", "/api/migrations", "/api/admin/migrations"];

function hasPrefix(pathname: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix));
}

function isReadRequest(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD";
}

/**
 * The bookmark the browser's last response left on it, if any.
 * @public Exercised by the unit tests.
 */
export function readD1Bookmark(request: Request): string | undefined {
	const cookie = request.headers.get("cookie");
	if (!cookie) return undefined;
	for (const part of cookie.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1 || part.slice(0, separator).trim() !== D1_BOOKMARK_COOKIE) continue;
		const raw = part.slice(separator + 1).trim();
		if (!raw) return undefined;
		try {
			return decodeURIComponent(raw) || undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** @public Exercised by the unit tests. */
export function d1SessionMode(request: Request): D1SessionMode {
	const { pathname } = new URL(request.url);
	if (request.headers.has("authorization") || hasPrefix(pathname, OFF_PREFIXES)) return "off";
	if (hasPrefix(pathname, PRIMARY_PREFIXES)) return "primary";
	return "replica";
}

/**
 * Where the session starts: the primary for `primary` paths and for a write without a bookmark, otherwise the
 * browser's bookmark, or anywhere on a first visit.
 * @public Exercised by the unit tests.
 */
export function d1SessionConstraint(request: Request, mode: Exclude<D1SessionMode, "off">): string {
	if (mode === "primary") return "first-primary";
	return readD1Bookmark(request) ?? (isReadRequest(request) ? "first-unconstrained" : "first-primary");
}

/** The session-backed `DB` a request sees, mapped to the raw binding it came from. */
const primaries = new WeakMap<object, D1Database>();

export type SessionDatabase = D1Database & Pick<D1DatabaseSession, "getBookmark">;

/**
 * A `D1Database` whose queries run on the session. `exec`, `dump` and `withSession` exist only on the binding, so
 * they go to the primary; nothing in the request path uses them.
 * @public Exercised by the unit tests.
 */
export function sessionDatabase(primary: D1Database, session: D1DatabaseSession): SessionDatabase {
	const database = {
		prepare: (query: string) => session.prepare(query),
		batch: <T = unknown>(statements: D1PreparedStatement[]) => session.batch<T>(statements),
		exec: (query: string) => primary.exec(query),
		dump: () => primary.dump(),
		withSession: (constraintOrBookmark?: string) => primary.withSession(constraintOrBookmark),
		getBookmark: () => session.getBookmark(),
	} as unknown as SessionDatabase;
	primaries.set(database, primary);
	return database;
}

/**
 * The raw binding behind a session database, or the database itself. Authentication and the migration runner read
 * it: a replica can lag writes no bookmark of this browser covers (a session revoked on another device, an account
 * just disabled, a migration another admin applied).
 */
export function primaryDatabase<T extends D1Database | undefined>(database: T): T {
	return ((database && primaries.get(database)) as T | undefined) ?? database;
}

/** Opens the request's session, or null when it runs without one (mode `off`, Node, a binding without sessions). */
export function openD1Session(
	env: Pick<CloudflareEnv, "DB" | "KITE_RUNTIME">,
	request: Request,
): SessionDatabase | null {
	if (env.KITE_RUNTIME === "node") return null;
	const mode = d1SessionMode(request);
	if (mode === "off") return null;
	const binding = env.DB;
	if (!binding || typeof binding.withSession !== "function" || primaries.has(binding)) return null;
	const session = binding.withSession(d1SessionConstraint(request, mode));
	if (!session || typeof session.prepare !== "function") return null;
	return sessionDatabase(binding, session);
}

const sessionEnvs = new WeakMap<object, WeakMap<object, object>>();

/**
 * The env with `DB` swapped for the session, cached per pair. Worker bindings are not enumerable, so the env cannot
 * be spread; a proxy reads every other binding from the env itself (as its own receiver). Its target is a blank
 * object, so a binding defined as non-configurable on the env cannot trip the proxy invariants.
 */
export function withD1Session<T extends { DB?: D1Database }>(env: T, database: SessionDatabase): T {
	let byEnv = sessionEnvs.get(database);
	if (!byEnv) sessionEnvs.set(database, (byEnv = new WeakMap()));
	const cached = byEnv.get(env);
	if (cached) return cached as T;
	const proxy = new Proxy({} as T, {
		get: (_target, property) => (property === "DB" ? database : Reflect.get(env, property)),
		has: (_target, property) => property === "DB" || Reflect.has(env, property),
	});
	byEnv.set(env, proxy);
	return proxy;
}

/**
 * The `Set-Cookie` value storing the session's newest bookmark, or null. Only writes and a first visit store it: a
 * slow read finishing after a write would otherwise replace the newer bookmark with an older one and break
 * read-your-writes. `getBookmark()` is null until a query ran on the session.
 * @public Exercised by the unit tests.
 */
export function d1BookmarkCookie(request: Request, bookmark: string | null | undefined): string | null {
	if (!bookmark) return null;
	if (isReadRequest(request) && readD1Bookmark(request)) return null;
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${D1_BOOKMARK_COOKIE}=${encodeURIComponent(bookmark)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** The response with the bookmark cookie added; untouched without one and for a WebSocket upgrade. */
export function withD1BookmarkCookie(request: Request, response: Response, database: SessionDatabase | null): Response {
	if (!database || response.status === 101 || response.webSocket) return response;
	const cookie = d1BookmarkCookie(request, database.getBookmark());
	if (!cookie) return response;
	const copy = new Response(response.body, response);
	copy.headers.append("Set-Cookie", cookie);
	return copy;
}
