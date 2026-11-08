import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Creating or removing an assistant address must only call the Cloudflare API for a domain that actually
// receives through Cloudflare Email Routing: an SES-receiving domain has no Worker route to create or remove,
// and must never reach Cloudflare at all (docs/specs/assistant-by-email.md §10, §13).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-assistant-addresses-gate-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as createAddress } from "./src/app/api/admin/assistant-addresses/route.ts";
			export { DELETE as deleteAddress } from "./src/app/api/admin/assistant-addresses/[id]/route.ts";
		`,
		resolveDir: root,
		sourcefile: "assistant-addresses-gate-entry.ts",
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
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, createAddress, deleteAddress } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, receiving_provider, created_at) VALUES
			('cf-domain', 'admin', 'cf.example.com', 'zone-cf', 'active', 'cloudflare', 'cloudflare', 1),
			('ses-domain', 'admin', 'ses.example.com', 'zone-ses', 'active', 'cloudflare', 'ses', 1);
	`);
	const env = { DB: database, CF_TOKEN: "test-only", KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const session = await createSession(env, "admin");
	const fetchCalls = [];
	const rules = [];
	let nextRuleId = 0;
	t.mock.method(globalThis, "fetch", async (url, init = {}) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, "https://api.cloudflare.com", "must never contact a non-Cloudflare origin");
		const match = parsed.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/email\/routing\/rules(?:\/([^/]+))?$/);
		assert.ok(match, parsed.pathname);
		const [, zoneId, ruleId] = match;
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body) : null;
		fetchCalls.push({ method, zoneId, ruleId });
		if (method === "GET")
			return Response.json({ success: true, result: rules.filter((rule) => rule.zoneId === zoneId) });
		if (method === "POST") {
			const rule = { ...body, id: `rule-${++nextRuleId}`, zoneId };
			rules.push(rule);
			return Response.json({ success: true, result: rule });
		}
		const index = rules.findIndex((rule) => rule.id === ruleId && rule.zoneId === zoneId);
		assert.notEqual(index, -1);
		if (method === "DELETE") rules.splice(index, 1);
		if (method === "PUT") rules[index] = { ...body, id: ruleId, zoneId };
		return Response.json({ success: true, result: rules[index] ?? null });
	});
	const authHeaders = { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
	const create = (domainId, localPart) =>
		createAddress(
			new Request("https://kite.test/api/admin/assistant-addresses", {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({ domainId, localPart }),
			}),
		);
	const destroy = (id) =>
		deleteAddress(
			new Request(`https://kite.test/api/admin/assistant-addresses/${id}`, {
				method: "DELETE",
				headers: authHeaders,
			}),
			{ params: Promise.resolve({ id }) },
		);
	return { database, fetchCalls, create, destroy };
}

test("creating an assistant address on an SES-receiving domain never calls the Cloudflare API", async (t) => {
	const { fetchCalls, create } = await fixture(t);
	const response = await create("ses-domain", "assistant");
	assert.equal(response.status, 201);
	assert.deepEqual(fetchCalls, []);
});

test("creating an assistant address on a Cloudflare-receiving domain creates the routing rule", async (t) => {
	const { fetchCalls, create } = await fixture(t);
	const response = await create("cf-domain", "assistant");
	assert.equal(response.status, 201);
	assert.ok(
		fetchCalls.some((call) => call.method === "POST"),
		"expected a rule-creating call",
	);
});

test("removing an assistant address on an SES-receiving domain never calls the Cloudflare API", async (t) => {
	const { database, fetchCalls, create, destroy } = await fixture(t);
	const created = await create("ses-domain", "assistant");
	assert.equal(created.status, 201);
	const { id } = database.db.prepare("SELECT id FROM assistant_addresses").get() ?? {};
	assert.ok(id);
	fetchCalls.length = 0;
	const response = await destroy(id);
	assert.equal(response.status, 200);
	assert.deepEqual(fetchCalls, []);
});

test("removing an assistant address on a Cloudflare-receiving domain removes the routing rule", async (t) => {
	const { database, fetchCalls, create, destroy } = await fixture(t);
	const created = await create("cf-domain", "assistant");
	assert.equal(created.status, 201);
	const { id } = database.db.prepare("SELECT id FROM assistant_addresses").get() ?? {};
	assert.ok(id);
	fetchCalls.length = 0;
	const response = await destroy(id);
	assert.equal(response.status, 200);
	assert.ok(
		fetchCalls.some((call) => call.method === "DELETE"),
		"expected a rule-removing call",
	);
});
