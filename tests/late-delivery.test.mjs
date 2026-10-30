import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// A worker that delivers late, after its send was taken back (a stuck send moved to Drafts), must not turn the
// draft back into a sent or failed message or rewrite the job that recovery already settled.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-late-delivery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { sendEmail, processOutboundQueue } from "./src/lib/email/send.ts";
		`,
		resolveDir: root,
		sourcefile: "late-delivery-entry.ts",
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
	plugins: [
		{
			// Lets a test stand in for the claim re-check just before the provider call.
			name: "job-claim-override",
			setup(build) {
				build.onResolve({ filter: /^@\/lib\/email\/job-claim$/ }, () => ({
					path: "job-claim-override",
					namespace: "job-claim-override",
				}));
				// The real check unless a test sets `globalThis.__kiteClaimCheck`.
				build.onLoad({ filter: /.*/, namespace: "job-claim-override" }, () => ({
					contents: `
						import { isJobClaimed as real } from "./src/lib/email/job-claim.ts";
						export { renewJobClaim } from "./src/lib/email/job-claim.ts";
						export const isJobClaimed = (db, jobId) => (globalThis.__kiteClaimCheck ?? real)(db, jobId);
					`,
					resolveDir: root,
					loader: "ts",
				}));
			},
		},
	],
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, sendEmail, processOutboundQueue } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const input = {
	userId: "admin",
	from: "owner@one.test",
	mailboxId: "mb",
	to: "a@x.test",
	subject: "Late worker",
	text: "Hi",
};

/** What the author's Move to Drafts does to a stuck send (see cancelQueuedSend). */
function recover(database) {
	database.db.exec(`
		UPDATE outbound_jobs SET status = 'failed', error = 'Moved to Drafts after the send stalled' WHERE status = 'sending';
		UPDATE messages SET status = 'draft' WHERE status = 'queued';
	`);
}

async function fixture(t, send) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone', 'active', 'cloudflare', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'admin', 'one', 'owner', 1);
	`);
	database.db.exec(`
		INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at)
			VALUES ('hook', 'admin', 'https://hooks.example.com/kite', 'plain', '["message.outbound"]', 1, 1, 1);
	`);
	const queued = [];
	const calls = [];
	const env = {
		DB: database,
		BUCKET: { get: async () => null, put: async () => undefined, delete: async () => undefined },
		EMAIL: {
			send: async (message) => {
				calls.push(message);
				return send(database);
			},
		},
		OUTBOUND_QUEUE: { send: async (message) => void queued.push(message) },
		KITE_RUNTIME: "node",
	};
	return { database, env, calls, queued };
}

const webhookEvents = (database) =>
	database.db.prepare("SELECT event_type AS eventType FROM webhook_deliveries ORDER BY id").all();
const sendAudits = (database) =>
	database.db.prepare("SELECT metadata FROM audit_logs WHERE action = 'email.send'").all();

// The webhook endpoint is never reached: the delivery row is what these tests read.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("ok");
after(() => {
	globalThis.fetch = realFetch;
	delete globalThis.__kiteClaimCheck;
});

const rows = (database) => ({
	message: database.db.prepare("SELECT status, provider_message_id AS providerId FROM messages").get(),
	job: database.db.prepare("SELECT status, error FROM outbound_jobs").get(),
});

test("a normal send still ends as sent with its job sent", async (t) => {
	const { database, env } = await fixture(t, async () => ({ messageId: "<ok@one.test>" }));
	await sendEmail(env, input);
	assert.deepEqual(rows(database), {
		message: { status: "sent", providerId: "<ok@one.test>" },
		job: { status: "sent", error: null },
	});
	assert.deepEqual(webhookEvents(database), [{ eventType: "message.outbound" }]);
	const audits = sendAudits(database);
	assert.equal(audits.length, 1);
	assert.doesNotMatch(audits[0].metadata, /lateAfterRecovery/);
});

test("a scheduled send run by the outbound queue ends as sent, with its webhook and audit entry", async (t) => {
	const { database, env, calls, queued } = await fixture(t, async () => ({ messageId: "<scheduled@one.test>" }));
	const scheduledAt = new Date(Date.now() + 3_600_000);
	const result = await sendEmail(env, { ...input, scheduledAt });
	assert.equal(result.scheduled, true);
	assert.equal(queued.length, 1);
	assert.equal(calls.length, 0);
	assert.deepEqual(rows(database), {
		message: { status: "queued", providerId: null },
		job: { status: "queued", error: null },
	});

	// The consumer gets the message once its time has come.
	await processOutboundQueue(env, { ...queued[0], scheduledAt: new Date(Date.now() - 1_000).toISOString() });
	assert.equal(calls.length, 1);
	assert.deepEqual(rows(database), {
		message: { status: "sent", providerId: "<scheduled@one.test>" },
		job: { status: "sent", error: null },
	});
	assert.deepEqual(webhookEvents(database), [{ eventType: "message.outbound" }]);
	assert.equal(sendAudits(database).length, 1);
	// A redelivered queue message finds the job settled and does nothing.
	await processOutboundQueue(env, { ...queued[0], scheduledAt: new Date(Date.now() - 1_000).toISOString() });
	assert.equal(calls.length, 1);
});

test("a failing status write is not mistaken for a late delivery: the normal steps still run", async (t) => {
	const { database, env } = await fixture(t, async () => ({ messageId: "<flaky@one.test>" }));
	// A transient database error on the sent write: the step is swallowed, nothing matched or not is known.
	database.db.exec(`
		CREATE TRIGGER flaky_sent_write BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent'
		BEGIN SELECT RAISE(ABORT, 'transient D1 error'); END;
	`);
	await sendEmail(env, input);
	assert.equal(rows(database).job.status, "sent");
	assert.deepEqual(webhookEvents(database), [{ eventType: "message.outbound" }]);
	const audits = sendAudits(database);
	assert.equal(audits.length, 1);
	assert.doesNotMatch(audits[0].metadata, /lateAfterRecovery/);
});

test("a worker that delivers after recovery leaves the draft and the settled job alone", async (t) => {
	const { database, env, calls } = await fixture(t, async (db) => {
		recover(db);
		return { messageId: "<late@one.test>" };
	});
	await sendEmail(env, input);
	assert.equal(calls.length, 1);
	assert.deepEqual(rows(database), {
		message: { status: "draft", providerId: null },
		job: { status: "failed", error: "Moved to Drafts after the send stalled" },
	});
	// The mail did go out, so a trace is kept.
	const audit = database.db.prepare("SELECT metadata FROM audit_logs WHERE action = 'email.send'").all();
	assert.equal(audit.length, 1);
	assert.match(audit[0].metadata, /lateAfterRecovery/);
});

test("a worker that fails after recovery does not mark the draft failed or overwrite the job", async (t) => {
	const { database, env } = await fixture(t, async (db) => {
		recover(db);
		throw new Error("provider down");
	});
	await assert.rejects(sendEmail(env, input), /provider down/);
	assert.deepEqual(rows(database), {
		message: { status: "draft", providerId: null },
		job: { status: "failed", error: "Moved to Drafts after the send stalled" },
	});
});

test("a worker whose job was taken back before the provider call does not deliver, and says so", async (t) => {
	const { database, env, calls } = await fixture(t, async () => ({ messageId: "<x@one.test>" }));
	// Recovery lands between claiming the job and the provider call; the re-check sees it.
	globalThis.__kiteClaimCheck = async () => {
		recover(database);
		return false;
	};
	t.after(() => delete globalThis.__kiteClaimCheck);
	await assert.rejects(sendEmail(env, input), /taken back before it was delivered/);
	assert.equal(calls.length, 0);
	assert.equal(rows(database).message.status, "draft");
	assert.equal(rows(database).job.status, "failed");
	assert.deepEqual(webhookEvents(database), []);
});
