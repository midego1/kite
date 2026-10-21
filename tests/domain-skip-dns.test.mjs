import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-skip-dns-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export * from "./src/lib/domains/skip-dns-utils.ts";
			export { adoptCloudflareZone } from "./src/lib/domains/adopt-zone.ts";
			export { addDomainForUser, addSkippedDomainForUser, getDomainForUser, listUserDomains } from "./src/lib/domains/service.ts";
			export { getDomainProvisioningError } from "./src/lib/domains/errors.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
			export { createDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "skip-dns-entry.ts",
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
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const kite = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("isDomainHostname accepts mail domains and rejects anything else", () => {
	for (const hostname of ["example.test", "mail.example.co.uk", "a-b.example.org", "example.xn--p1ai"]) {
		assert.equal(kite.isDomainHostname(hostname), true, hostname);
	}
	for (const hostname of [
		"localhost",
		"example",
		"-bad.example.test",
		"bad-.example.test",
		"exa mple.test",
		"example..test",
		"example.1",
		"user@example.test",
		`${"a".repeat(64)}.test`,
		`${"a.".repeat(127)}test`,
	]) {
		assert.equal(kite.isDomainHostname(hostname), false, hostname);
	}
});

test("shouldAdoptZone only adopts a skipped manual zone when Cloudflare can be asked", () => {
	assert.equal(kite.shouldAdoptZone({ zoneId: "manual", dnsSkipped: true }, true), true);
	assert.equal(kite.shouldAdoptZone({ zoneId: "manual", dnsSkipped: true }, false), false);
	assert.equal(kite.shouldAdoptZone({ zoneId: "manual", dnsSkipped: false }, true), false);
	assert.equal(kite.shouldAdoptZone({ zoneId: "zone-1", dnsSkipped: true }, true), false);
});

test("ZoneAdoptionError carries the status each failure answers with", () => {
	assert.equal(new kite.ZoneAdoptionError("ZONE_CLAIMED", "taken").status, 409);
	assert.equal(new kite.ZoneAdoptionError("ZONE_NOT_FOUND", "absent").status, 422);
	assert.equal(new kite.ZoneAdoptionError("ZONE_LOOKUP_FAILED", "down").status, 502);
	assert.deepEqual(kite.zoneAdoptionFailure(new kite.ZoneAdoptionError("ZONE_NOT_FOUND", "absent")), {
		status: 422,
		body: { error: "absent", code: "ZONE_NOT_FOUND" },
	});
	assert.equal(kite.zoneAdoptionFailure(new Error("other")), null);
});

test("skippedDomainValues records the manual zone, no providers and the flag", () => {
	assert.deepEqual(kite.skippedDomainValues("dom-1", "user-1", "skip.example.test"), {
		id: "dom-1",
		userId: "user-1",
		hostname: "skip.example.test",
		zoneId: "manual",
		status: "active",
		receivingProvider: "none",
		sendingProvider: "none",
		routingStatus: null,
		sendingSubdomainTag: null,
		sendingRequested: false,
		sendingEnabled: false,
		routingEnabled: false,
		dnsSkipped: true,
	});
});

async function database(t, sql = "") {
	const directory = mkdtempSync(join(tmpdir(), "kite-skip-dns-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const db = new kite.SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => db.db.close());
	await kite.applyMigrations(db, join(root, "drizzle", "migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('user-1', 'owner@example.test', 'hash', 'Owner', 1),
			('user-2', 'other@example.test', 'hash', 'Other', 1);
		${sql}
	`);
	return db;
}

/** Answers Cloudflare's zone lookup with `zones` for the duration of one test. */
function stubZoneLookup(t, respond) {
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "api.cloudflare.com");
		return respond(url);
	};
	t.after(() => {
		globalThis.fetch = original;
	});
}

const zonesAnswer = (zones) => Response.json({ success: true, result: zones, errors: [] });

test("a skipped domain is added without Cloudflare and accepts mail once its DNS points at Kite", async (t) => {
	const env = { DB: await database(t), CF_TOKEN: "token" };
	stubZoneLookup(t, () => assert.fail("skipping DNS must not call Cloudflare"));
	const { domain, changes } = await kite.addSkippedDomainForUser(env, "user-1", " Skip.Example.Test ");
	assert.equal(domain.hostname, "skip.example.test");
	assert.equal(domain.zoneId, "manual");
	assert.equal(domain.dnsSkipped, true);
	assert.equal(domain.receivingProvider, "none");
	assert.equal(domain.sendingProvider, "none");
	assert.equal(domain.status, "active");
	assert.equal(changes.zoneId, "manual");

	env.DB.db.exec(
		`INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, created_at) VALUES ('mbx-1', 'user-1', '${domain.id}', 'me', 'Me', 1)`,
	);
	const decision = await kite.resolveInboundAddress(kite.createDb(env.DB), "me@skip.example.test");
	assert.equal(decision?.action, "store");
	assert.equal(decision?.mailbox?.mailboxId, "mbx-1");
});

test("adding a skipped domain refuses bad names, other owners and domains already added", async (t) => {
	const env = { DB: await database(t) };
	await assert.rejects(kite.addSkippedDomainForUser(env, "user-1", "not a domain"), /domain name/);
	await kite.addSkippedDomainForUser(env, "user-2", "taken.example.test");
	await assert.rejects(kite.addSkippedDomainForUser(env, "user-1", "taken.example.test"), /already registered/);
	await assert.rejects(kite.addSkippedDomainForUser(env, "user-2", "taken.example.test"), /already added/);
});

test("skipping DNS before the migration is applied answers MIGRATION_PENDING, other adds still work", async (t) => {
	const env = { DB: await database(t, "ALTER TABLE domains DROP COLUMN dns_skipped;") };
	const error = await kite.addSkippedDomainForUser(env, "user-1", "early.example.test").catch((e) => e);
	assert.deepEqual(kite.getDomainProvisioningError(error, "Failed"), {
		code: "MIGRATION_PENDING",
		message: kite.getDomainProvisioningError(error, "Failed").message,
		status: 409,
	});
	assert.deepEqual(await kite.listUserDomains(env, "user-1"), []);

	const { domain } = await kite.addDomainForUser(env, "user-1", "normal.example.test", { sendingProvider: "none" });
	assert.equal(domain.dnsSkipped, false);
	const [listed] = await kite.listUserDomains(env, "user-1");
	assert.equal(listed.dnsSkipped, false);
});

test("adoptCloudflareZone attaches the real zone to a skipped domain", async (t) => {
	const env = { DB: await database(t), CF_TOKEN: "token" };
	const { domain } = await kite.addSkippedDomainForUser(env, "user-1", "adopt.example.test");
	stubZoneLookup(t, (url) =>
		zonesAnswer(url.searchParams.get("name") === "example.test" ? [{ id: "zone-1", name: "example.test" }] : []),
	);
	const adopted = await kite.adoptCloudflareZone(env, domain);
	assert.equal(adopted.zoneId, "zone-1");
	assert.equal((await kite.getDomainForUser(env, "user-1", domain.id)).zoneId, "zone-1");
	assert.equal(await kite.adoptCloudflareZone(env, adopted), adopted);
});

test("adoptCloudflareZone leaves manual zones alone without credentials or a skip", async (t) => {
	const env = { DB: await database(t) };
	stubZoneLookup(t, () => assert.fail("nothing to adopt"));
	const { domain: skipped } = await kite.addSkippedDomainForUser(env, "user-1", "skip.example.test");
	assert.equal(await kite.adoptCloudflareZone(env, skipped), skipped);
	const { domain: manual } = await kite.addDomainForUser(env, "user-1", "manual.example.test", {
		sendingProvider: "none",
	});
	assert.equal(manual.zoneId, "manual");
	assert.equal(await kite.adoptCloudflareZone({ ...env, CF_TOKEN: "token" }, manual), manual);
});

test("adoptCloudflareZone refuses a zone claimed by another account and reports lookups that fail", async (t) => {
	const env = {
		DB: await database(
			t,
			"INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('dom-other', 'user-2', 'other.example.test', 'zone-1', 1);",
		),
		CF_TOKEN: "token",
	};
	const { domain } = await kite.addSkippedDomainForUser(env, "user-1", "mine.example.test");
	let answer = (url) =>
		zonesAnswer(url.searchParams.get("name") === "example.test" ? [{ id: "zone-1", name: "example.test" }] : []);
	stubZoneLookup(t, (url) => answer(url));
	await assert.rejects(kite.adoptCloudflareZone(env, domain), { code: "ZONE_CLAIMED", status: 409 });

	answer = () => zonesAnswer([]);
	await assert.rejects(kite.adoptCloudflareZone(env, domain), { code: "ZONE_NOT_FOUND", status: 422 });

	answer = () =>
		Response.json({ success: false, result: null, errors: [{ code: 10000, message: "Authentication error" }] });
	await assert.rejects(kite.adoptCloudflareZone(env, domain), { code: "ZONE_LOOKUP_FAILED", status: 502 });
	assert.equal((await kite.getDomainForUser(env, "user-1", domain.id)).zoneId, "manual");
});
