import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-send-metrics-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { sendEmail } from "./src/lib/email/send.ts";
			export { statusClass } from "./src/lib/metrics.mjs";
		`,
		resolveDir: root,
		sourcefile: "send-metrics-entry.ts",
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
const { SqliteDatabase, applyMigrations, sendEmail, statusClass } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

async function fixture(t, sendResult) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, reset_email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', NULL, 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone', 'active', 'cloudflare', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'admin', 'one', 'owner', 1);
	`);
	const points = [];
	const env = {
		DB: database,
		BUCKET: { get: async () => null, put: async () => undefined, delete: async () => undefined },
		EMAIL: { send: sendResult },
		METRICS: { writeDataPoint: (point) => points.push(point) },
		KITE_RUNTIME: "node",
	};
	return { env, points };
}

const mixed = {
	userId: "admin",
	from: "owner@one.test",
	mailboxId: "mb",
	to: ["a@x.test", "b@x.test"],
	cc: "c@x.test",
	bcc: ["d@x.test", "e@x.test"],
	subject: "Hello",
	text: "Hi",
};

test("a successful send records To + CC + BCC recipients as attempts", async (t) => {
	const { env, points } = await fixture(t, async () => ({ messageId: "<id@one.test>" }));
	await sendEmail(env, mixed);
	const sends = points.filter((point) => point.indexes[0] === "send");
	assert.equal(sends.length, 1);
	assert.equal(sends[0].blobs[3], "sent");
	assert.equal(sends[0].doubles[2], 5);
});

test("a failed send records To + CC + BCC recipients as attempts", async (t) => {
	const { env, points } = await fixture(t, async () => {
		throw new Error("provider down");
	});
	await assert.rejects(sendEmail(env, mixed));
	const sends = points.filter((point) => point.indexes[0] === "send");
	assert.equal(sends.length, 1);
	assert.equal(sends[0].blobs[3], "failed");
	assert.equal(sends[0].doubles[2], 5);
});

test("the bundled metrics module labels status classes", () => {
	assert.equal(statusClass(204), "2xx");
});
