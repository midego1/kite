import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-import-size-pause-");
after(() => rmSync(directory, { recursive: true, force: true }));

/** The IMAP session and the module host are replaced; everything else in the job code is real and runs on SQLite. */
const stubs = {
	"./imap": `
		export async function openImportSession() {
			const fake = globalThis.__fakeImport;
			if (fake.openError) throw new Error(fake.openError);
			fake.opened += 1;
			return {
				examine: async () => undefined,
				searchUids: async () => fake.uids.map(String),
				fetchMessages: async (uids) =>
					new Map(
						uids.map((uid) => [
							uid,
							{ raw: new TextEncoder().encode("Subject: x\\r\\n\\r\\nbody"), flags: [], internalDate: null, size: null },
						]),
					),
				close: async () => undefined,
			};
		}
	`,
	"@/lib/modules/host": `
		export const moduleHost = {
			mail: {
				importMessages: async (_ctx, request) => {
					const fake = globalThis.__fakeImport;
					fake.batches.push(request.messages.length);
					fake.afterBatch?.();
					return { imported: request.messages.length, skipped: 0, failed: 0, errors: [] };
				},
			},
		};
	`,
};

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createImportJob, processImportJob, resumeImportJob, resumeStalledImportJobs } from "./src/lib/import/jobs.ts";
			export { getDatabaseSize } from "./src/lib/db/size.ts";
		`,
		resolveDir: root,
		sourcefile: "import-size-pause-entry.ts",
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
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [
		{
			name: "stub-import-runtime",
			setup(build) {
				build.onResolve({ filter: /^(\.\/imap|@\/lib\/modules\/host)$/ }, (args) => ({
					path: args.path,
					namespace: "stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
			},
		},
	],
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	createImportJob,
	processImportJob,
	resumeImportJob,
	resumeStalledImportJobs,
	getDatabaseSize,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const DAY = 24 * 60 * 60;

/** A migrated SQLite database whose D1 limit is set so the database sits at `ratio` of it. */
async function fixture(t, ratio) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, can_manage_users, created_at) VALUES ('admin', 'o@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
		CREATE TABLE scratch (id INTEGER PRIMARY KEY, filler BLOB);
	`);
	const env = { DB: database, APP_ENCRYPTION_KEY: "import-size-pause-test-key-0123456789abcdef" };
	const used = (await getDatabaseSize(env)).usedBytes;
	const setRatio = (value) => {
		env.D1_MAX_BYTES = String(Math.ceil(used / value));
	};
	setRatio(ratio);
	globalThis.__fakeImport = { uids: [], opened: 0, batches: [], openError: null, afterBatch: null };
	t.after(() => delete globalThis.__fakeImport);
	return { env, database, used, setRatio };
}

const jobFields = {
	userId: "admin",
	mailboxId: "box",
	label: "INBOX",
	destination: "system:inbox",
	host: "imap.test",
	port: 993,
	secure: true,
	username: "me",
	password: "secret",
	folder: "INBOX",
	maxMessages: null,
};
const ctx = {};
const row = (database, id) => database.db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id);

test("a job claimed while the database is above 90% pauses before it connects, keeping its password and cursor", async (t) => {
	const { env, database } = await fixture(t, 0.94);
	globalThis.__fakeImport.uids = [3, 2, 1];
	const job = await createImportJob(env, jobFields);
	await processImportJob(env, job.id, ctx);
	const paused = row(database, job.id);
	assert.equal(paused.status, "paused");
	assert.match(paused.last_error, /above 90% of its size limit/);
	assert.notEqual(paused.password, "");
	assert.equal(paused.lease_until, null);
	assert.equal(globalThis.__fakeImport.opened, 0);
});

test("a running import stops after the batch that fills the database and pauses with its progress saved", async (t) => {
	const { env, database, used } = await fixture(t, 0.47);
	globalThis.__fakeImport.uids = Array.from({ length: 100 }, (_, index) => index + 1);
	// The first batch grows the database from 47% to about 94% of the limit.
	globalThis.__fakeImport.afterBatch = () => {
		database.db.prepare("INSERT INTO scratch (filler) VALUES (?)").run(Buffer.alloc(used));
	};
	const job = await createImportJob(env, jobFields);
	await processImportJob(env, job.id, ctx);
	const paused = row(database, job.id);
	assert.equal(paused.status, "paused");
	assert.match(paused.last_error, /size limit/);
	assert.deepEqual(globalThis.__fakeImport.batches, [25]);
	assert.equal(paused.processed, 25);
	assert.equal(paused.imported, 25);
	assert.equal(paused.cursor_uid, 76);
	assert.notEqual(paused.password, "");
});

test("a cancelled job still stops the loop and is not paused over it", async (t) => {
	const { env, database } = await fixture(t, 0.3);
	globalThis.__fakeImport.uids = Array.from({ length: 100 }, (_, index) => index + 1);
	const job = await createImportJob(env, jobFields);
	globalThis.__fakeImport.afterBatch = () =>
		database.db.prepare("UPDATE import_jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
	await processImportJob(env, job.id, ctx);
	assert.equal(row(database, job.id).status, "cancelled");
	assert.deepEqual(globalThis.__fakeImport.batches, [25]);
});

test("a confirmed import goes on above 90% and a transient error keeps the confirmation", async (t) => {
	const { env, database } = await fixture(t, 0.94);
	globalThis.__fakeImport.uids = Array.from({ length: 60 }, (_, index) => index + 1);
	const job = await createImportJob(env, { ...jobFields, confirmedDatabaseFull: true });
	globalThis.__fakeImport.openError = "connection reset";
	await processImportJob(env, job.id, ctx);
	let current = row(database, job.id);
	assert.equal(current.status, "running");
	assert.equal(current.attempts, 1);
	assert.match(current.last_error, /as confirmed/);

	globalThis.__fakeImport.openError = null;
	database.db.prepare("UPDATE import_jobs SET lease_until = NULL WHERE id = ?").run(job.id);
	await processImportJob(env, job.id, ctx);
	current = row(database, job.id);
	assert.equal(current.status, "completed");
	assert.deepEqual(globalThis.__fakeImport.batches, [25, 25, 10]);
	assert.equal(current.password, "");
});

test("even a confirmed import pauses at 98% of the limit", async (t) => {
	const { env, database } = await fixture(t, 0.99);
	globalThis.__fakeImport.uids = [1, 2, 3];
	const job = await createImportJob(env, { ...jobFields, confirmedDatabaseFull: true });
	await processImportJob(env, job.id, ctx);
	const paused = row(database, job.id);
	assert.equal(paused.status, "paused");
	assert.match(paused.last_error, /almost at its size limit/);
});

test("resume asks for confirmation above 90%, refuses above 98% and clears the way below", async (t) => {
	const { env, database, setRatio } = await fixture(t, 0.94);
	const job = await createImportJob(env, jobFields);
	database.db
		.prepare(
			"UPDATE import_jobs SET status = 'paused', last_error = 'Paused: the database is above 90% of its size limit.' WHERE id = ?",
		)
		.run(job.id);

	assert.equal(await resumeImportJob(env, "admin", "nobody", { confirmed: true }), "not_found");
	assert.equal(await resumeImportJob(env, "someone-else", job.id, { confirmed: true }), "not_found");
	assert.equal(await resumeImportJob(env, "admin", job.id, { confirmed: false }), "needs_confirmation");
	assert.equal(row(database, job.id).status, "paused");

	setRatio(0.99);
	assert.equal(await resumeImportJob(env, "admin", job.id, { confirmed: true }), "full");
	assert.equal(row(database, job.id).status, "paused");

	setRatio(0.94);
	assert.equal(await resumeImportJob(env, "admin", job.id, { confirmed: true }), "resumed");
	const resumed = row(database, job.id);
	assert.equal(resumed.status, "pending");
	assert.match(resumed.last_error, /as confirmed/);
	assert.equal(await resumeImportJob(env, "admin", job.id, { confirmed: true }), "not_found");

	setRatio(0.3);
	database.db.prepare("UPDATE import_jobs SET status = 'paused', last_error = 'Paused: x' WHERE id = ?").run(job.id);
	assert.equal(await resumeImportJob(env, "admin", job.id, { confirmed: false }), "resumed");
	assert.equal(row(database, job.id).last_error, null);
});

test("the cron cancels a job paused for more than 7 days and erases its password, but not a younger one", async (t) => {
	const { env, database } = await fixture(t, 0.3);
	const old = await createImportJob(env, jobFields);
	const recent = await createImportJob(env, { ...jobFields, username: "other" });
	assert.notEqual(row(database, old.id).password, "");
	const now = Math.floor(Date.now() / 1000);
	database.db
		.prepare("UPDATE import_jobs SET status = 'paused', updated_at = ? WHERE id = ?")
		.run(now - 8 * DAY, old.id);
	database.db
		.prepare("UPDATE import_jobs SET status = 'paused', updated_at = ? WHERE id = ?")
		.run(now - 6 * DAY, recent.id);

	await resumeStalledImportJobs(env, ctx, async () => true);

	const cancelled = row(database, old.id);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.password, "");
	assert.notEqual(cancelled.finished_at, null);
	assert.match(cancelled.last_error, /7 days/);
	const kept = row(database, recent.id);
	assert.equal(kept.status, "paused");
	assert.notEqual(kept.password, "");
});
