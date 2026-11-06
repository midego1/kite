import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The sign-in guard on a real (SQLite) database: what stays after a sign-in, and what a cancelled one leaves.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-sign-in-guard-");
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { importSignInGuard, SignInLimitError } from "./src/lib/import/sign-in-limit.ts";
		`,
		resolveDir: root,
		sourcefile: "sign-in-guard-entry.ts",
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
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, importSignInGuard, SignInLimitError } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const SERVER = { host: "imap.example.com", port: 993 };

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(
		"INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u@one.test', 'hash', 'U', 'user', 1)",
	);
	const env = { DB: database };
	// The attempts that count as failures (cancelled ones are marked, see `cancelledRows`).
	const attempts = (aborted) =>
		database.db
			.prepare(
				`SELECT id FROM audit_logs WHERE action = 'import.sign_in_attempt' AND actor_user_id = 'u1' AND json_extract(metadata, '$.aborted') IS ${aborted ? "NOT" : ""} NULL`,
			)
			.all().length;
	const rows = () => attempts(false);
	const cancelledRows = () => attempts(true);
	return { env, rows, cancelledRows, guard: importSignInGuard(env, "u1") };
}

const refused = () => Promise.reject(new Error("IMAP sign-in failed: A1 NO [AUTHENTICATIONFAILED] bad"));

test("a sign-in that works leaves no row, a failed one stays, and the sixth failure at a server is refused", async (t) => {
	const { rows, guard } = await fixture(t);
	assert.equal(await guard(SERVER, async () => "session"), "session");
	assert.equal(rows(), 0);
	for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(guard(SERVER, refused), /sign-in failed/);
	assert.equal(rows(), 5);
	let connected = false;
	await assert.rejects(
		guard(SERVER, async () => (connected = true)),
		(error) => error instanceof SignInLimitError && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 600,
	);
	assert.equal(connected, false, "nothing connects past the limit");
	assert.equal(rows(), 5, "a refused attempt leaves no row");
	// Another server has its own count.
	assert.equal(await guard({ host: "other.example.com", port: 993 }, async () => "ok"), "ok");
});

test("parallel attempts cannot all see room: at most the limit get through", async (t) => {
	const { guard } = await fixture(t);
	let reached = 0;
	const results = await Promise.allSettled(
		Array.from({ length: 20 }, () =>
			guard(SERVER, async () => {
				reached += 1;
				throw new Error("IMAP sign-in failed: NO");
			}),
		),
	);
	assert.ok(reached <= 5, `${reached} reached the server`);
	assert.ok(results.some((result) => result.reason instanceof SignInLimitError));
});

test("a cancelled sign-in is not a failure, but a refusal the server already sent stays one", async (t) => {
	const { rows, cancelledRows, guard } = await fixture(t);
	const controller = new AbortController();
	// Aborting closes the socket, so the pending read fails with a plain error, not an AbortError.
	await assert.rejects(
		guard(
			SERVER,
			async () => {
				controller.abort();
				throw new Error("The connection was closed");
			},
			controller.signal,
		),
		/connection was closed/,
	);
	assert.equal(rows(), 0);
	assert.equal(cancelledRows(), 1);
	const second = new AbortController();
	await assert.rejects(
		guard(
			SERVER,
			async () => {
				second.abort();
				throw new Error("IMAP sign-in failed: A1 NO [AUTHENTICATIONFAILED] bad");
			},
			second.signal,
		),
		/sign-in failed/,
	);
	assert.equal(rows(), 1);
	// Cancelling again and again never runs a correct password into the limit.
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const aborted = new AbortController();
		await assert.rejects(
			guard(
				SERVER,
				async () => {
					aborted.abort();
					throw new Error("The connection was closed");
				},
				aborted.signal,
			),
		);
	}
	assert.equal(await guard(SERVER, async () => "ok"), "ok");
});

test("cancelling is bounded too: the credentials may have been sent before the cancel", async (t) => {
	const { rows, cancelledRows, guard } = await fixture(t);
	const cancel = () => {
		const controller = new AbortController();
		return guard(
			SERVER,
			async () => {
				controller.abort();
				throw new Error("The connection was closed");
			},
			controller.signal,
		);
	};
	for (let attempt = 0; attempt < 31; attempt += 1) await assert.rejects(cancel(), /connection was closed/);
	assert.equal(rows(), 0);
	// The attempt being checked is still in flight, not yet marked, so the one after the 30th marked is the last.
	assert.equal(cancelledRows(), 31);
	await assert.rejects(cancel(), (error) => error instanceof SignInLimitError);
});
