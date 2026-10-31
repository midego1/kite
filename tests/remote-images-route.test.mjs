import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-remote-images-route-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
// Session routes read the cookie through next/headers, which needs a Next request scope; the shim serves the test's cookie.
const cookieShim = join(bundleDirectory, "next-headers-shim.mjs");
writeFileSync(
	cookieShim,
	`export async function cookies() {
		return { get: (name) => (globalThis.__remoteImagesCookie?.name === name ? globalThis.__remoteImagesCookie : undefined) };
	}`,
);
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET } from "./src/app/api/remote-images/route.ts";
		`,
		resolveDir: root,
		sourcefile: "remote-images-route-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": cookieShim,
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, GET } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const APP = "https://mail.kite-test.com";
const IMAGE = "https://images.example.com/logo.png";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function fixture(t, extraEnv = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('helper', 'helper@one.test', 'hash', 'Helper', 'user', 0, 2),
			('stranger', 'stranger@one.test', 'hash', 'Stranger', 'user', 0, 3);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at)
			VALUES ('one', 'owner', 'one.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('private', 'owner', 'one', 'owner', 'personal', 1),
			('team', 'owner', 'one', 'team', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at)
			VALUES ('grant', 'team', 'helper', 'read_only', 1);
	`);
	const insertMessage = (id, mailboxId, html) =>
		database.db
			.prepare(
				`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, html_body, status, created_at)
					VALUES (?, 'owner', ?, 'inbound', 'news@example.com', 'owner@one.test', ?, 'received', 1)`,
			)
			.run(id, mailboxId, html);
	insertMessage("private-message", "private", `<p>Hi</p><img src="${IMAGE}" alt="logo">`);
	insertMessage("team-message", "team", `<img src="http://images.example.com/team.png">`);
	insertMessage("private-ip-message", "private", `<img src="http://169.254.169.254/latest/meta-data/">`);
	insertMessage("text-message", "private", null);

	const env = { DB: database, ...extraEnv };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		delete globalThis.__remoteImagesCookie;
	});
	const sessions = {
		owner: await createSession(env, "owner"),
		helper: await createSession(env, "helper"),
		stranger: await createSession(env, "stranger"),
	};
	const outbound = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		outbound.push({ url: String(url), init });
		return new Response(PNG, {
			headers: {
				"Content-Type": "image/png",
				"Cross-Origin-Resource-Policy": "same-origin",
				"Set-Cookie": "tracker=1",
				"Access-Control-Allow-Origin": "*",
			},
		});
	});
	const call = async (as, query, headers = {}) => {
		globalThis.__remoteImagesCookie = as ? { name: "ep_session", value: sessions[as] } : undefined;
		const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
		return GET(new Request(`${APP}/api/remote-images?${search}`, { headers }));
	};
	return { env, call, outbound, sessions };
}

test("an anonymous caller gets 401 and nothing is fetched", async (t) => {
	const { call, outbound } = await fixture(t);
	const response = await call(null, { message: "private-message", url: IMAGE });
	assert.equal(response.status, 401);
	assert.equal(outbound.length, 0);
});

test("the owner gets the image from this origin with private, sandboxed, no-sniff headers and no upstream header", async (t) => {
	const { call, outbound, sessions } = await fixture(t);
	const response = await call(
		"owner",
		{ message: "private-message", url: IMAGE },
		{
			Cookie: `ep_session=${sessions.owner}; other=secret`,
			Authorization: "Basic dXNlcjpwYXNz",
			Referer: `${APP}/inbox`,
			"X-Forwarded-For": "203.0.113.9",
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...PNG]);
	assert.equal(response.headers.get("content-type"), "image/png");
	assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
	assert.equal(response.headers.get("vary"), "Cookie");
	assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
	assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	assert.equal(response.headers.has("set-cookie"), false);
	assert.equal(response.headers.has("access-control-allow-origin"), false);

	assert.equal(outbound.length, 1);
	assert.equal(outbound[0].url, IMAGE);
	const sent = new Headers(outbound[0].init.headers);
	assert.deepEqual([...sent.keys()].sort(), ["accept", "user-agent"]);
	assert.equal(outbound[0].init.redirect, "manual");
});

test("a member with delegated access to a shared mailbox may load its images; http is fetched over https", async (t) => {
	const { call, outbound } = await fixture(t);
	const response = await call("helper", { message: "team-message", url: "http://images.example.com/team.png" });
	assert.equal(response.status, 200);
	assert.equal(outbound[0].url, "https://images.example.com/team.png");
});

test("a URL the message does not show, or a message the user cannot read, answers 404 without fetching", async (t) => {
	const { call, outbound } = await fixture(t);
	for (const [as, query] of [
		["owner", { message: "private-message", url: "https://images.example.com/other.png" }],
		["owner", { message: "private-message", url: "https://evil.example.com/logo.png" }],
		["owner", { message: "team-message", url: IMAGE }],
		["owner", { message: "text-message", url: IMAGE }],
		["owner", { message: "missing", url: IMAGE }],
		["stranger", { message: "private-message", url: IMAGE }],
		["stranger", { message: "team-message", url: "http://images.example.com/team.png" }],
		["helper", { message: "private-message", url: IMAGE }],
	]) {
		const response = await call(as, query);
		assert.equal(response.status, 404, `${as} ${JSON.stringify(query)}`);
		assert.equal(response.headers.get("cache-control"), "no-store");
	}
	assert.equal(outbound.length, 0);
});

test("missing parameters and unsafe URLs answer 400 before any lookup or fetch, even when the message names them", async (t) => {
	const { call, outbound } = await fixture(t);
	for (const query of [
		"",
		"message=private-message",
		`url=${encodeURIComponent(IMAGE)}`,
		{ message: "private-ip-message", url: "http://169.254.169.254/latest/meta-data/" },
		{ message: "private-message", url: "http://127.0.0.1/a.png" },
		{ message: "private-message", url: "file:///etc/passwd" },
		{ message: "private-message", url: `${APP}/api/messages` },
	]) {
		const response = await call("owner", query);
		assert.equal(response.status, 400, JSON.stringify(query));
	}
	assert.equal(outbound.length, 0);
});

test("the per-user rate limit answers 429 before any fetch, and a limiter error lets the request through", async (t) => {
	const keys = [];
	let allow = false;
	const { call, outbound, env } = await fixture(t, {
		REMOTE_IMAGE_RATE_LIMIT: {
			limit: async ({ key }) => {
				keys.push(key);
				return { success: allow };
			},
		},
	});
	const query = { message: "private-message", url: IMAGE };
	assert.equal((await call("owner", query)).status, 429);
	assert.deepEqual(keys, ["owner"]);
	assert.equal(outbound.length, 0);
	allow = true;
	assert.equal((await call("owner", query)).status, 200);

	t.mock.method(console, "warn", () => {});
	env.REMOTE_IMAGE_RATE_LIMIT = {
		limit: async () => {
			throw new Error("limiter down");
		},
	};
	assert.equal((await call("owner", query)).status, 200);
});

test("the self-hosted runtime proxies after resolving every hop to a public address", async (t) => {
	const resolved = [];
	let answers = { "images.example.com": ["93.184.216.34"] };
	const { call, outbound } = await fixture(t, {
		KITE_RUNTIME: "node",
		RESOLVE_HOST: async (hostname) => {
			resolved.push(hostname);
			return answers[hostname] ?? [];
		},
	});
	const query = { message: "private-message", url: IMAGE };
	const response = await call("owner", query);
	assert.equal(response.status, 200);
	assert.deepEqual(resolved, ["images.example.com"]);
	assert.equal(outbound.length, 1);

	answers = { "images.example.com": ["10.0.0.7"] };
	const rebound = await call("owner", query);
	assert.equal(rebound.status, 400, "a name resolving to a private address is refused");
	assert.equal(outbound.length, 1, "nothing is fetched");

	answers = { "images.example.com": [] };
	assert.equal((await call("owner", query)).status, 400, "an unresolvable name is refused");
	assert.equal(outbound.length, 1);
});

test("a redirect to a host that resolves privately is refused before it is fetched", async (t) => {
	const answers = { "images.example.com": ["93.184.216.34"], "cdn.example.net": ["192.168.1.4"] };
	const { call, outbound } = await fixture(t, {
		KITE_RUNTIME: "node",
		RESOLVE_HOST: async (hostname) => answers[hostname] ?? [],
	});
	t.mock.method(globalThis, "fetch", async (url) => {
		outbound.push({ url: String(url) });
		return new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/logo.png" } });
	});
	const response = await call("owner", { message: "private-message", url: IMAGE });
	assert.equal(response.status, 400);
	assert.deepEqual(
		outbound.map((request) => request.url),
		[IMAGE],
	);
});

test("the loopback allowance needs the dev flag and is ignored in production", async (t) => {
	const loopbackImage = "http://127.0.0.1:4567/pixel.png";
	const { call, outbound, env } = await fixture(t);
	env.DB.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, html_body, status, created_at)
				VALUES ('loopback', 'owner', 'private', 'inbound', 'a@example.com', 'owner@one.test', ?, 'received', 1)`,
		)
		.run(`<img src="${loopbackImage}">`);
	const query = { message: "loopback", url: loopbackImage };
	assert.equal((await call("owner", query)).status, 400);
	env.REMOTE_IMAGES_ALLOW_LOOPBACK = "1";
	assert.equal((await call("owner", query)).status, 200);
	assert.equal(outbound.at(-1).url, loopbackImage);
	const nodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	t.after(() => {
		if (nodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = nodeEnv;
	});
	assert.equal((await call("owner", query)).status, 400);
});

test("upstream failures answer with the proxy's own status and an uncached JSON error", async (t) => {
	const { call } = await fixture(t);
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
	);
	const unsupported = await call("owner", { message: "private-message", url: IMAGE });
	assert.equal(unsupported.status, 415);
	assert.equal(unsupported.headers.get("cache-control"), "no-store");
	assert.match(unsupported.headers.get("content-type"), /application\/json/);

	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/a.png" } }),
	);
	assert.equal((await call("owner", { message: "private-message", url: IMAGE })).status, 400);
});
