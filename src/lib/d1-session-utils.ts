/**
 * D1 read-replica sessions for the fetch handler (ported from upstream Mailflare #268).
 *
 * Every request used to run all its queries on `env.DB` directly, so D1 sent every read to the primary. A browser
 * request now runs on a D1 session (`env.DB.withSession()`) anchored at the bookmark its last response left in the
 * bookmark cookie, so reads may be served by a read replica while the browser still sees its own writes (sequential
 * consistency). With read replication off in Cloudflare a session behaves exactly like the binding.
 *
 * Only the D1 binding is wrapped, through a proxy (Worker bindings are not enumerable, so the env cannot be
 * spread), and before `withStorage`, so every `getEnv()` caller gets it. The queue, email and scheduled handlers,
 * the realtime Durable Object and the Node runtime keep the raw binding (the primary).
 */

/** The cookie on plain http (local development), where the `__Host-` prefix cannot be used. */
const PLAIN_COOKIE = "kite_d1_bm";
/** The cookie over https: `__Host-` makes browsers refuse it from a sibling subdomain or without `Secure`. */
const HOST_COOKIE = "__Host-kite_d1_bm";

/**
 * Stored instead of a bookmark after a request wrote to the raw primary binding (the migration runner), which no
 * session bookmark covers: the browser's next request starts its session on the primary.
 */
const PRIMARY_MARKER = "first-primary";

/**
 * Sent by the browser on a refetch the realtime hub triggered (new mail, a queue job finished): those writes were
 * made outside this browser's session, so its bookmark does not cover them and the refetch reads the primary.
 */
export const D1_PRIMARY_READ_HEADER = "x-kite-read-primary";

/**
 * `off`: no session and no cookie, the raw binding answers. `primary`: a session whose first query goes to the
 * primary, for paths whose reads must be current. `replica`: a session anchored at the browser's bookmark.
 */
type D1SessionMode = "off" | "primary" | "replica";

/**
 * Surfaces without a browser that keeps our cookies, or that promise to set none: webhooks and inbound mail, public
 * links (Drive, large attachments) and public booking and contact pages, the remote-image proxy, bearer-token APIs
 * (REST, JMAP, MCP, OAuth clients), which cannot carry a bookmark between requests and would otherwise miss their
 * own writes, and the realtime upgrade, which hands the connection to the Durable Object.
 */
const OFF_PREFIXES = [
	"/api/inbound",
	"/api/public/",
	"/api/shared-files/",
	"/d/",
	"/book/",
	"/c/",
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

function isHttps(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

function cookieName(request: Request): string {
	return isHttps(request) ? HOST_COOKIE : PLAIN_COOKIE;
}

/**
 * The raw value of the bookmark cookie, if any.
 * @public Exercised by the unit tests.
 */
export function readD1Bookmark(request: Request): string | undefined {
	const cookie = request.headers.get("cookie");
	if (!cookie) return undefined;
	const name = cookieName(request);
	for (const part of cookie.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
		const raw = part.slice(separator + 1).trim();
		if (!raw) return undefined;
		try {
			return decodeURIComponent(raw) || undefined;
		} catch {
			return raw;
		}
	}
	return undefined;
}

/**
 * D1 bookmarks are hyphen-separated hex groups (`00000085-0000024c-00004c6d-8e61…83`): fixed-width counters for the
 * position in the database's global order, then a hash. Anything else is refused before it reaches `withSession`.
 * @public Exercised by the unit tests.
 */
export function isValidD1Bookmark(value: string): boolean {
	return value.length <= 160 && /^[0-9a-f]{1,32}(?:-[0-9a-f]{1,64}){1,7}$/i.test(value);
}

/**
 * Orders two bookmarks by their counter groups (every group but the trailing hash): negative when `a` is older,
 * positive when newer, 0 for the same position, null when they cannot be compared (another shape).
 * @public Exercised by the unit tests.
 */
export function compareD1Bookmarks(a: string, b: string): number | null {
	if (!isValidD1Bookmark(a) || !isValidD1Bookmark(b)) return null;
	const left = a.split("-");
	const right = b.split("-");
	if (left.length !== right.length) return null;
	for (let index = 0; index < left.length - 1; index += 1) {
		const difference = BigInt(`0x${left[index]}`) - BigInt(`0x${right[index]}`);
		if (difference !== BigInt(0)) return difference < BigInt(0) ? -1 : 1;
	}
	return 0;
}

/** What the browser's cookie holds. */
type IncomingBookmark =
	{ kind: "none" } | { kind: "bookmark"; value: string } | { kind: "primary" } | { kind: "invalid" };

/** @public Exercised by the unit tests. */
export function incomingD1Bookmark(request: Request): IncomingBookmark {
	const value = readD1Bookmark(request);
	if (!value) return { kind: "none" };
	if (value === PRIMARY_MARKER) return { kind: "primary" };
	return isValidD1Bookmark(value) ? { kind: "bookmark", value } : { kind: "invalid" };
}

/** @public Exercised by the unit tests. */
export function d1SessionMode(request: Request): D1SessionMode {
	const { pathname } = new URL(request.url);
	if (request.headers.has("authorization") || hasPrefix(pathname, OFF_PREFIXES)) return "off";
	if (hasPrefix(pathname, PRIMARY_PREFIXES) || request.headers.get(D1_PRIMARY_READ_HEADER) === "1") return "primary";
	return "replica";
}

/**
 * Where the session starts: the primary for `primary` requests, after a primary-only write and for a write without
 * a usable bookmark; otherwise the browser's bookmark, or anywhere on a read without one.
 * @public Exercised by the unit tests.
 */
export function d1SessionConstraint(request: Request, mode: Exclude<D1SessionMode, "off">): string {
	if (mode === "primary") return "first-primary";
	const incoming = incomingD1Bookmark(request);
	if (incoming.kind === "bookmark") return incoming.value;
	if (incoming.kind === "primary") return "first-primary";
	return isReadRequest(request) ? "first-unconstrained" : "first-primary";
}

/** Per-request session state, keyed by the session-backed `DB`. */
interface SessionState {
	primary: D1Database;
	session: D1DatabaseSession;
	/** The session was anchored at the browser's bookmark, so a refusal of it can be recovered from once. */
	recoverable: boolean;
	/** The browser's cookie must be replaced: it was malformed, or D1 refused it. */
	resetCookie: boolean;
	/** A statement on the session reported a change to the database. */
	wrote: boolean;
	/** Something wrote to the raw primary binding, past what the session bookmark covers. */
	primaryWrite: boolean;
}

const states = new WeakMap<object, SessionState>();

export type SessionDatabase = D1Database & Pick<D1DatabaseSession, "getBookmark">;

/** D1's refusal of a bookmark it cannot serve; the message wording is D1's, so only the word is matched. */
function isBookmarkRefusal(error: unknown): boolean {
	return error instanceof Error && /bookmark/i.test(error.message);
}

function noteResult(state: SessionState, result: unknown): void {
	const results = Array.isArray(result) ? result : [result];
	for (const entry of results) {
		const meta = (entry as { meta?: { changed_db?: boolean; changes?: number; rows_written?: number } } | null)?.meta;
		if (meta && (meta.changed_db || (meta.changes ?? 0) > 0 || (meta.rows_written ?? 0) > 0)) state.wrote = true;
	}
}

/** Runs a query; when D1 refuses the browser's bookmark, restarts the session on the primary and runs it again. */
async function execute<T>(state: SessionState, run: () => Promise<T>): Promise<T> {
	try {
		const result = await run();
		noteResult(state, result);
		return result;
	} catch (error) {
		if (!state.recoverable || !isBookmarkRefusal(error)) throw error;
		state.recoverable = false;
		state.resetCookie = true;
		state.session = state.primary.withSession("first-primary");
		const result = await run();
		noteResult(state, result);
		return result;
	}
}

/** A prepared statement that is bound to the session only when it runs, so a restarted session is picked up. */
class SessionStatement {
	constructor(
		private readonly state: SessionState,
		private readonly query: string,
		private readonly params: unknown[] = [],
	) {}

	bind(...values: unknown[]): SessionStatement {
		return new SessionStatement(this.state, this.query, values);
	}

	native(): D1PreparedStatement {
		const statement = this.state.session.prepare(this.query);
		return this.params.length ? statement.bind(...this.params) : statement;
	}

	first(column?: string) {
		return execute(this.state, () => (column === undefined ? this.native().first() : this.native().first(column)));
	}

	run() {
		return execute(this.state, () => this.native().run());
	}

	all() {
		return execute(this.state, () => this.native().all());
	}

	raw(options?: { columnNames?: boolean }) {
		return execute(this.state, () =>
			options?.columnNames ? this.native().raw({ columnNames: true }) : this.native().raw(),
		);
	}
}

/**
 * A `D1Database` whose queries run on the session. `exec`, `dump` and `withSession` exist only on the binding, so
 * they go to the primary; nothing in the request path uses them.
 * @public Exercised by the unit tests.
 */
export function sessionDatabase(
	primary: D1Database,
	session: D1DatabaseSession,
	options: { recoverable?: boolean; resetCookie?: boolean } = {},
): SessionDatabase {
	const state: SessionState = {
		primary,
		session,
		recoverable: options.recoverable ?? false,
		resetCookie: options.resetCookie ?? false,
		wrote: false,
		primaryWrite: false,
	};
	const database = {
		prepare: (query: string) => new SessionStatement(state, query),
		batch: (statements: unknown[]) =>
			execute(state, () =>
				state.session.batch(
					statements.map((statement) =>
						statement instanceof SessionStatement ? statement.native() : (statement as D1PreparedStatement),
					),
				),
			),
		exec: (query: string) => primary.exec(query),
		dump: () => primary.dump(),
		withSession: (constraintOrBookmark?: string) => primary.withSession(constraintOrBookmark),
		getBookmark: () => state.session.getBookmark(),
	} as unknown as SessionDatabase;
	states.set(database, state);
	return database;
}

/**
 * The raw binding behind a session database, or the database itself. Authentication and the migration runner read
 * it: a replica can lag writes no bookmark of this browser covers (a session revoked on another device, an account
 * just disabled, a migration another admin applied).
 */
export function primaryDatabase<T extends D1Database | undefined>(database: T): T {
	return ((database && states.get(database)?.primary) as T | undefined) ?? database;
}

/**
 * The key for an isolate cache over the database (schema readiness, module state, the storage config): the raw
 * binding, so every request's session shares one entry instead of starting a new one per request.
 */
export function databaseKey(database: D1Database): object {
	return primaryDatabase(database);
}

/**
 * Records a write made on the raw primary binding (`primaryDatabase`), so the response sends the browser's next
 * request to the primary: the session's bookmark does not cover it.
 */
export function notePrimaryWrite(database: D1Database | undefined): void {
	const state = database && states.get(database);
	if (state) state.primaryWrite = true;
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
	if (!binding || typeof binding.withSession !== "function" || states.has(binding)) return null;
	const incoming = incomingD1Bookmark(request);
	const constraint = d1SessionConstraint(request, mode);
	const anchored = constraint !== "first-primary" && constraint !== "first-unconstrained";
	let session: D1DatabaseSession | null = null;
	let resetCookie = incoming.kind === "invalid";
	try {
		session = binding.withSession(constraint);
	} catch (error) {
		if (!anchored) throw error;
		resetCookie = true;
		session = binding.withSession("first-primary");
	}
	if (!session || typeof session.prepare !== "function") return null;
	return sessionDatabase(binding, session, { recoverable: anchored && !resetCookie, resetCookie });
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
		set: (_target, property, value) => property !== "DB" && Reflect.set(env, property, value),
		ownKeys: () => [...new Set([...Reflect.ownKeys(env), "DB"])],
		getOwnPropertyDescriptor: (_target, property) => {
			if (property === "DB") return { value: database, writable: false, enumerable: true, configurable: true };
			const descriptor = Reflect.getOwnPropertyDescriptor(env, property);
			return descriptor && { ...descriptor, configurable: true };
		},
	});
	byEnv.set(env, proxy);
	return proxy;
}

/** What the response learned about the session, for `d1BookmarkCookie`. */
interface SessionOutcome {
	bookmark: string | null;
	wrote: boolean;
	primaryWrite: boolean;
	resetCookie: boolean;
}

function cookieHeader(request: Request, value: string, maxAge?: number): string {
	const secure = isHttps(request) ? "; Secure" : "";
	const age = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
	return `${cookieName(request)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}${age}`;
}

/**
 * The `Set-Cookie` value for the response, or null to leave the browser's cookie alone. A bookmark is stored when it
 * is newer than the one the browser sent (any write on the session moves it, whatever the HTTP method), so a slow
 * read can never move the cookie back past a newer write; with no bookmark to compare against, on a first visit or
 * to replace a refused one. A bookmark that cannot be ordered against the browser's is stored only after a write.
 * @public Exercised by the unit tests.
 */
export function d1BookmarkCookie(request: Request, outcome: SessionOutcome): string | null {
	if (outcome.primaryWrite) return cookieHeader(request, PRIMARY_MARKER);
	const incoming = incomingD1Bookmark(request);
	const { bookmark } = outcome;
	if (!bookmark || !isValidD1Bookmark(bookmark)) {
		return outcome.resetCookie || incoming.kind === "invalid" ? cookieHeader(request, "", 0) : null;
	}
	if (incoming.kind !== "bookmark" || outcome.resetCookie) return cookieHeader(request, bookmark);
	const order = compareD1Bookmarks(bookmark, incoming.value);
	if (order === null ? outcome.wrote : order > 0) return cookieHeader(request, bookmark);
	return null;
}

/** The response with the bookmark cookie added; untouched without one and for a WebSocket upgrade. */
export function withD1BookmarkCookie(request: Request, response: Response, database: SessionDatabase | null): Response {
	const state = database && states.get(database);
	if (!database || !state || response.status === 101 || response.webSocket) return response;
	const cookie = d1BookmarkCookie(request, {
		bookmark: database.getBookmark(),
		wrote: state.wrote,
		primaryWrite: state.primaryWrite,
		resetCookie: state.resetCookie,
	});
	if (!cookie) return response;
	const copy = new Response(response.body, response);
	copy.headers.append("Set-Cookie", cookie);
	return copy;
}
