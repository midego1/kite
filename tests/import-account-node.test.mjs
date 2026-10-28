import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { startFakeImap, sampleMessage } from "./support/fake-imap.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Whole-account imports (spec §4.1, §4.5) through the Node connector against the fake IMAP server: the mapping
// table, folders one after another, dedupe across folders, Gmail's labels, pause and resume, a changed UIDVALIDITY,
// and folder jobs on a database that has not applied migration 0076 yet.

const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	planAccountImport,
	createAccountImportJob,
	createImportJob,
	processImportJob,
	pauseImportJob,
	resumeImportJob,
	cancelImportJob,
	resumeStalledImportJobs,
	listImportJobs,
	serializeImportJob,
	DEFAULT_IMPORT_TIMING,
	resolveImportDestination,
	ImportMigrationPendingError,
	ImportJobSaveError,
	JOB_FOLDER_ROWS_PER_INSERT,
	jobFolderInserts,
	createDb,
} = await bundleModules("kite-import-account-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["planAccountImport", "src/lib/import/imap.ts"],
	[
		"createAccountImportJob, createImportJob, processImportJob, pauseImportJob, resumeImportJob, cancelImportJob, resumeStalledImportJobs, listImportJobs, serializeImportJob",
		"src/lib/import/jobs.ts",
	],
	["DEFAULT_IMPORT_TIMING", "src/lib/import/job-run.ts"],
	["resolveImportDestination", "src/lib/import/folders.ts"],
	[
		"ImportMigrationPendingError, ImportJobSaveError, JOB_FOLDER_ROWS_PER_INSERT, jobFolderInserts",
		"src/lib/import/account-jobs.ts",
	],
	["createDb", "src/db/index.ts"],
]);

const HOST = "imap.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const tls = createTestCertificate([HOST]);
const CTX = { viewer: { userId: "owner" }, moduleId: "import", grants: ["import.run"] };

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

async function fake(t, options) {
	const server = await startFakeImap({ tls, implicitTls: true, authPlain: true, saslIr: true, ...options });
	t.after(() => server.close());
	return server;
}

/** D1's limits on top of the SQLite database: at most 100 bound parameters, and `refuse` to fail chosen statements. */
function withD1Limits(db, limits) {
	return new Proxy(db, {
		get(target, key) {
			if (key !== "prepare") {
				const value = target[key];
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (sql) => {
				if (limits.refuse?.(sql)) throw new Error("D1_ERROR: refused by the test");
				const statement = target.prepare(sql);
				const bind = statement.bind.bind(statement);
				statement.bind = (...values) => {
					if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
					return bind(...values);
				};
				return statement;
			};
		},
	});
}

async function setup(t, server, migrationsDir = join(root, "drizzle/migrations")) {
	const db = new SqliteDatabase(":memory:");
	const limits = {};
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const queued = [];
	const delays = [];
	const env = {
		KITE_RUNTIME: "node",
		TCP_CONNECT: (address, options) => connect({ ...address, port: server.port }, options),
		DB: withD1Limits(db, limits),
		BUCKET: {
			put: async () => limits.onPut?.(),
			get: async () => null,
			head: async () => null,
			delete: async () => undefined,
		},
		AGENT_QUEUE: {
			send: async (message, options) => {
				queued.push(message);
				delays.push(options?.delaySeconds ?? 0);
			},
		},
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, queued, delays, limits };
}

const account = { host: HOST, port: 993, secure: true, username: USER, password: PASSWORD };
const mailbox = { id: "mailbox-a", userId: "owner" };

/** The plan's folders as the import page sends them back, with their destinations resolved as the route does. */
async function startAccountJob(env, plan) {
	const folders = [];
	for (const folder of plan.folders.filter((entry) => entry.include))
		folders.push({ ...folder, destination: await resolveImportDestination(env, mailbox, folder.destination) });
	return createAccountImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "Whole account",
		...account,
		folders,
		gmail: plan.gmail,
	});
}

/** Runs the job's queue messages until it stops waiting. */
async function drain(env, db, jobId) {
	for (let run = 0; run < 20; run += 1) {
		const { status } = db.db.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId);
		if (status !== "pending" && status !== "running") return status;
		db.db.prepare("UPDATE import_jobs SET lease_until = NULL WHERE id = ?").run(jobId);
		await processImportJob(env, jobId, CTX);
	}
	throw new Error("the job did not finish");
}

const placements = (db) =>
	Object.fromEntries(
		db.db
			.prepare(
				"SELECT m.subject, m.status, f.name AS folder FROM messages m LEFT JOIN folders f ON f.id = m.folder_id ORDER BY m.subject",
			)
			.all()
			.map((row) => [row.subject, row.folder ? `folder:${row.folder}` : row.status]),
	);

test("a whole account is planned, then copied folder by folder into Kite's statuses and folders", async (t) => {
	const shared = sampleMessage(9, { subject: "In two folders", messageId: "<shared@example.org>" });
	const server = await fake(t, {
		specialUse: true,
		statusSize: true,
		folderAttributes: {
			"Sent Items": ["\\Sent"],
			Archive: ["\\Archive"],
			Junk: ["\\Junk"],
			Trash: ["\\Trash"],
			Drafts: ["\\Drafts"],
		},
		folders: {
			INBOX: [{ raw: sampleMessage(1, { subject: "Inbox mail" }), flags: ["\\Seen"] }, shared],
			"Sent Items": [sampleMessage(2, { subject: "Sent mail" })],
			Archive: [sampleMessage(3, { subject: "Archived mail" }), shared],
			"Work/Clients": [sampleMessage(4, { subject: "Client mail" })],
			Junk: [sampleMessage(5, { subject: "Junk mail" })],
			Trash: [sampleMessage(6, { subject: "Trashed mail" })],
			Drafts: [sampleMessage(7, { subject: "Draft mail" })],
		},
	});
	const { db, env, queued } = await setup(t, server);

	const plan = await planAccountImport(env, account);
	assert.equal(plan.gmail, false);
	assert.deepEqual(
		plan.folders.map(({ sourceName, role, include, destination, messages }) => [
			sourceName,
			role,
			include,
			destination,
			messages,
		]),
		[
			["INBOX", "inbox", true, "system:inbox", 2],
			["Sent Items", "sent", true, "system:sent", 1],
			["Archive", "archive", true, "system:archived", 2],
			["Work/Clients", "user", true, "new:Work / Clients", 1],
			["Junk", "junk", false, "system:spam", 1],
			["Trash", "trash", false, "system:trash", 1],
		],
	);
	assert.ok(
		plan.folders.every((folder) => folder.bytes > 0),
		"STATUS=SIZE gives every folder's size",
	);

	const job = await startAccountJob(env, plan);
	assert.deepEqual(queued, [{ kind: "import.imap", jobId: job.id }]);
	assert.equal(await drain(env, db, job.id), "completed");

	assert.deepEqual(placements(db), {
		"Archived mail": "archived",
		"Client mail": "folder:Work / Clients",
		"In two folders": "received",
		"Inbox mail": "received",
		"Sent mail": "sent",
	});
	const [listed] = await listImportJobs(env, "owner");
	const serialized = serializeImportJob(listed);
	assert.equal(serialized.scope, "account");
	assert.deepEqual(
		serialized.folders.map(({ sourceName, status, total, imported, skipped }) => [
			sourceName,
			status,
			total,
			imported,
			skipped,
		]),
		[
			["INBOX", "completed", 2, 2, 0],
			["Sent Items", "completed", 1, 1, 0],
			// The message already imported from INBOX lands once, in the first folder.
			["Archive", "completed", 2, 1, 1],
			["Work/Clients", "completed", 1, 1, 0],
		],
	);
	assert.deepEqual([serialized.processed, serialized.imported, serialized.skipped, serialized.total], [6, 5, 1, 6]);
	assert.equal(db.db.prepare("SELECT password FROM import_jobs").get().password, "");
});

test("Gmail's All Mail is copied once and each message filed by its labels", async (t) => {
	const server = await fake(t, {
		gmail: true,
		specialUse: true,
		folderAttributes: {
			"[Gmail]/All Mail": ["\\All"],
			"[Gmail]/Sent Mail": ["\\Sent"],
			"[Gmail]/Spam": ["\\Junk"],
			"[Gmail]/Trash": ["\\Trash"],
			"[Gmail]/Drafts": ["\\Drafts"],
		},
		folders: {
			INBOX: [sampleMessage(1, { subject: "Duplicate view" })],
			"[Gmail]/All Mail": [
				{ raw: sampleMessage(10, { subject: "Labelled inbox" }), labels: ["\\Inbox", "Work"] },
				{ raw: sampleMessage(11, { subject: "Labelled sent" }), labels: ["\\Sent"] },
				{ raw: sampleMessage(12, { subject: "Two labels" }), labels: ["Work", "Alpha"] },
				{ raw: sampleMessage(13, { subject: "No labels" }), labels: [] },
				{ raw: sampleMessage(14, { subject: "A draft" }), labels: ["\\Draft"] },
			],
			"[Gmail]/Sent Mail": [sampleMessage(11, { subject: "Duplicate view of sent" })],
			"[Gmail]/Spam": [sampleMessage(15, { subject: "Spam" })],
			"[Gmail]/Trash": [sampleMessage(16, { subject: "Trash" })],
			Work: [sampleMessage(12, { subject: "Duplicate label view" })],
		},
	});
	const { db, env } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	assert.equal(plan.gmail, true);
	assert.deepEqual(
		plan.folders.map(({ sourceName, include }) => [sourceName, include]),
		[
			["[Gmail]/All Mail", true],
			["[Gmail]/Spam", false],
			["[Gmail]/Trash", false],
		],
	);
	const job = await startAccountJob(env, plan);
	assert.equal(await drain(env, db, job.id), "completed");
	assert.deepEqual(placements(db), {
		"Labelled inbox": "received",
		"Labelled sent": "sent",
		"No labels": "archived",
		"Two labels": "folder:Alpha",
	});
	const [folder] = serializeImportJob((await listImportJobs(env, "owner"))[0]).folders;
	assert.deepEqual([folder.imported, folder.skipped, folder.multiLabel], [4, 1, 1]);
	assert.ok(server.commands.some((entry) => /X-GM-LABELS/.test(entry.line)));
});

test("a paused job keeps its place, resumes, and starts a folder over when its UIDVALIDITY changes", async (t) => {
	const inbox = Array.from({ length: 230 }, (_, index) => sampleMessage(index + 1, { subject: `Bulk ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox } });
	const { db, env, queued } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));

	// One run copies 200 messages (the run budget) and hands over to the next.
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 200);
	assert.equal(queued.length, 2);

	assert.equal(await pauseImportJob(env, "owner", job.id), true);
	const paused = db.db.prepare("SELECT status, pause_reason, paused_at, password FROM import_jobs").get();
	assert.equal(paused.status, "paused");
	assert.equal(paused.pause_reason, "user");
	assert.ok(paused.paused_at > 0);
	assert.notEqual(paused.password, "", "a paused job keeps its saved password");
	// The queued run finds the job paused and leaves it alone.
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 200);
	assert.equal(await pauseImportJob(env, "owner", job.id), false, "pausing twice is a no-op");

	server.bumpUidValidity("INBOX");
	assert.equal(await resumeImportJob(env, "owner", job.id, { confirmed: false }), "resumed");
	assert.equal(db.db.prepare("SELECT pause_reason FROM import_jobs").get().pause_reason, null);
	assert.equal(await drain(env, db, job.id), "completed");
	// The folder started over under the new UIDVALIDITY; dedupe skipped what was already there.
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 230);
	const folder = db.db.prepare("SELECT status, imported, skipped, uidvalidity FROM import_job_folders").get();
	assert.deepEqual(folder, { status: "completed", imported: 230, skipped: 200, uidvalidity: 2 });
});

test("a folder the server refuses fails alone and the rest of the account is copied", async (t) => {
	const server = await fake(t, { folders: { INBOX: [sampleMessage(1, { subject: "Still copied" })] } });
	const { db, env } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	const job = await startAccountJob(env, {
		...plan,
		folders: [
			{ sourceName: "Gone", role: "user", include: true, destination: "new:Gone", bytes: null },
			...plan.folders,
		],
	});
	assert.equal(await drain(env, db, job.id), "completed");
	const folders = db.db
		.prepare("SELECT source_name, status, last_error FROM import_job_folders ORDER BY position")
		.all();
	assert.equal(folders[0].status, "failed");
	assert.match(folders[0].last_error, /NONEXISTENT/);
	assert.equal(folders[1].status, "completed");
	assert.deepEqual(placements(db), { "Still copied": "received" });
	const finished = db.db.prepare("SELECT status, last_error FROM import_jobs").get();
	assert.deepEqual(finished, { status: "completed", last_error: "1 folder could not be imported" });
});

test("a transient refusal of a folder retries the run instead of failing the folder", async (t) => {
	const examineRefusals = { INBOX: "NO [THROTTLED] Too many requests, slow down" };
	const server = await fake(t, {
		examineRefusals,
		folders: { INBOX: [sampleMessage(1, { subject: "After the wait" })] },
	});
	const { db, env, queued } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	await processImportJob(env, job.id, CTX);
	const retried = db.db.prepare("SELECT status, attempts, last_error FROM import_jobs").get();
	assert.equal(retried.status, "running");
	assert.equal(retried.attempts, 1);
	assert.match(retried.last_error, /THROTTLED/);
	assert.equal(db.db.prepare("SELECT status FROM import_job_folders").get().status, "pending");
	assert.deepEqual(queued.at(-1), { kind: "import.imap", jobId: job.id }, "the retry is queued");

	delete examineRefusals.INBOX;
	assert.equal(await drain(env, db, job.id), "completed");
	assert.deepEqual(placements(db), { "After the wait": "received" });
	assert.equal(db.db.prepare("SELECT last_error FROM import_jobs").get().last_error, null);
});

test("thirty folders are saved within D1's 100 bound parameters, with the plan's counts as totals", async (t) => {
	const names = Array.from({ length: 30 }, (_, index) => `Folder ${String(index + 1).padStart(2, "0")}`);
	const server = await fake(t, {
		folders: Object.fromEntries(names.map((name, index) => [name, [sampleMessage(index + 1, { subject: name })]])),
	});
	const { db, env } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	assert.equal(plan.folders.length, 30);
	const job = await startAccountJob(env, plan);
	const saved = db.db.prepare("SELECT source_name, total FROM import_job_folders ORDER BY position").all();
	assert.deepEqual(
		saved.map((row) => row.source_name),
		names,
	);
	assert.ok(saved.every((row) => row.total === 1));
	assert.equal(db.db.prepare("SELECT total FROM import_jobs").get().total, 30, "the progress bar has a total at once");
	assert.equal(await drain(env, db, job.id), "completed");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 30);
});

test("every folder insert statement binds at most 100 parameters", () => {
	const db = createDb(new SqliteDatabase(":memory:"));
	assert.ok(JOB_FOLDER_ROWS_PER_INSERT >= 1 && JOB_FOLDER_ROWS_PER_INSERT <= 7);
	const folders = Array.from({ length: 500 }, (_, index) => ({
		sourceName: `Folder ${index}`,
		role: "user",
		destination: `folder:fld_${index}`,
		messages: index,
		bytes: index * 1000,
	}));
	const inserts = jobFolderInserts(db, "ijob_test", folders);
	assert.equal(inserts.length, Math.ceil(500 / JOB_FOLDER_ROWS_PER_INSERT));
	for (const insert of inserts) assert.ok(insert.toSQL().params.length <= 100, `${insert.toSQL().params.length}`);
	assert.deepEqual(
		jobFolderInserts(db, "ijob_test", folders.slice(0, 1)).map((insert) => insert.toSQL().params.length > 0),
		[true],
	);
});

test("a job whose folders cannot be saved is removed with its password and answers a save error", async (t) => {
	const server = await fake(t, {});
	const { db, env, queued, limits } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	limits.refuse = (sql) => /^insert into "import_job_folders"/i.test(sql);
	await assert.rejects(startAccountJob(env, plan), ImportJobSaveError);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM import_jobs").get().count, 0);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM import_job_folders").get().count, 0);
	assert.deepEqual(queued, [], "nothing was queued");
});

test("Pause and a quick Resume during a batch never start a second run beside it", async (t) => {
	const inbox = Array.from({ length: 60 }, (_, index) => sampleMessage(index + 1, { subject: `Race ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox } });
	const { db, env, limits } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	const signIns = () => server.commands.filter((entry) => /^\S+ (LOGIN|AUTHENTICATE)\b/i.test(entry.line)).length;
	let second = null;
	limits.onPut = async () => {
		if (second) return;
		limits.onPut = undefined;
		// While the first batch is being written: Pause, Resume, and the run that Resume queued.
		assert.equal(await pauseImportJob(env, "owner", job.id), true);
		assert.equal(await resumeImportJob(env, "owner", job.id, { confirmed: false }), "resumed");
		const before = signIns();
		second = processImportJob(env, job.id, CTX);
		await second;
		assert.equal(signIns(), before, "the queued run met the lease and left without signing in");
	};
	await processImportJob(env, job.id, CTX);
	assert.ok(second, "the batch was interrupted");
	// The first run took the job back and finished it; every message landed once.
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "completed");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 60);
});

test("a run stopped by Pause hands the job back, so Resume starts it at once", async (t) => {
	const inbox = Array.from({ length: 60 }, (_, index) => sampleMessage(index + 1, { subject: `Hand ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox } });
	const { db, env, queued, limits } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	limits.onPut = async () => {
		limits.onPut = undefined;
		assert.equal(await pauseImportJob(env, "owner", job.id), true);
	};
	await processImportJob(env, job.id, CTX);
	const paused = db.db.prepare("SELECT status, lease_until, processed FROM import_jobs").get();
	assert.deepEqual([paused.status, paused.lease_until, paused.processed], ["paused", null, 25]);
	queued.length = 0;
	assert.equal(await resumeImportJob(env, "owner", job.id, { confirmed: false }), "resumed");
	assert.deepEqual(queued, [{ kind: "import.imap", jobId: job.id }]);
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "completed");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 60);
});

test("Cancel and the 7-day limit on a paused job close the folders it never reached", async (t) => {
	const server = await fake(t, {
		folders: { INBOX: [sampleMessage(1)], Archive: [sampleMessage(2)], Work: [sampleMessage(3)] },
	});
	const { db, env } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	const cancelled = await startAccountJob(env, plan);
	const expired = await startAccountJob(env, plan);
	assert.equal(await cancelImportJob(env, "someone-else", cancelled.id), false);
	assert.equal(await cancelImportJob(env, "owner", cancelled.id), true);
	assert.equal(await pauseImportJob(env, "owner", expired.id), true);
	db.db.prepare("UPDATE import_jobs SET updated_at = 1 WHERE id = ?").run(expired.id);
	await resumeStalledImportJobs(env, CTX, async () => true);
	for (const id of [cancelled.id, expired.id]) {
		const row = db.db.prepare("SELECT status, password FROM import_jobs WHERE id = ?").get(id);
		assert.deepEqual(row, { status: "cancelled", password: "" });
		const statuses = db.db.prepare("SELECT DISTINCT status FROM import_job_folders WHERE job_id = ?").all(id);
		assert.deepEqual(statuses, [{ status: "skipped" }]);
	}
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const examines = (server) => server.commands.filter((entry) => /^\S+ (EXAMINE|SELECT)\b/i.test(entry.line)).length;
const folderStatuses = (db) => db.db.prepare("SELECT DISTINCT status FROM import_job_folders").all();

/**
 * Makes the first write to `import_job_folders` of a run meet a job that was cancelled just before it. `closing`
 * adds what Cancel does besides: closing the open folders.
 */
function cancelBeforeFirstFolderWrite(db, limits, jobId, closing) {
	limits.refuse = (sql) => {
		if (!/^update "import_job_folders"/i.test(sql)) return false;
		limits.refuse = undefined;
		db.db.prepare("UPDATE import_jobs SET status = 'cancelled', lease_until = NULL WHERE id = ?").run(jobId);
		if (closing)
			db.db
				.prepare(
					"UPDATE import_job_folders SET status = 'skipped' WHERE job_id = ? AND status IN ('pending', 'running')",
				)
				.run(jobId);
		return false;
	};
}

for (const [name, folders, closing] of [
	["a Cancel before the first folder is opened (folders left open)", { INBOX: [1], Archive: [2], Work: [3] }, false],
	["a Cancel before the first folder is opened (folders closed)", { INBOX: [1], Archive: [2], Work: [3] }, true],
	["empty folders, Cancel not yet closing them", { INBOX: [], Archive: [], Work: [] }, false],
	["empty folders, Cancel already closing them", { INBOX: [], Archive: [], Work: [] }, true],
]) {
	test(`${name}: no folder is left running and the later ones are not opened`, async (t) => {
		const server = await fake(t, {
			folders: Object.fromEntries(
				Object.entries(folders).map(([folder, uids]) => [folder, uids.map((uid) => sampleMessage(uid))]),
			),
		});
		const { db, env, limits } = await setup(t, server);
		const job = await startAccountJob(env, await planAccountImport(env, account));
		assert.equal(db.db.prepare("SELECT count(*) AS count FROM import_job_folders").get().count, 3);
		cancelBeforeFirstFolderWrite(db, limits, job.id, closing);
		await processImportJob(env, job.id, CTX);
		assert.equal(examines(server), 1, "the later folders were not opened");
		assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
		assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "cancelled");
		// Not left running, pending, completed or failed: the guard keeps Cancel's skipped, and the run's end closes the rest.
		assert.deepEqual(folderStatuses(db), [{ status: "skipped" }]);
	});
}

test("a folder the server refuses is not marked failed once the job was cancelled", async (t) => {
	const server = await fake(t, { folders: { INBOX: [sampleMessage(1)] } });
	const { db, env, limits } = await setup(t, server);
	const plan = await planAccountImport(env, account);
	const job = await startAccountJob(env, {
		...plan,
		folders: [
			{ sourceName: "Gone", role: "user", include: true, destination: "new:Gone", bytes: null },
			...plan.folders,
		],
	});
	cancelBeforeFirstFolderWrite(db, limits, job.id, true);
	await processImportJob(env, job.id, CTX);
	assert.equal(examines(server), 1, "the folder after the refused one was not opened");
	assert.deepEqual(folderStatuses(db), [{ status: "skipped" }]);
	assert.equal(
		db.db.prepare("SELECT last_error FROM import_job_folders WHERE source_name = 'Gone'").get().last_error,
		null,
	);
});

test("a failed job closes the folders its run left open", async (t) => {
	const server = await fake(t, { folders: { INBOX: [sampleMessage(1)], Archive: [sampleMessage(2)] } });
	const { db, env } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	db.db.prepare("UPDATE import_jobs SET attempts = 4 WHERE id = ?").run(job.id);
	// A refusal that is not tied to one folder fails the whole job on its last attempt.
	server.close();
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "failed");
	assert.deepEqual(folderStatuses(db), [{ status: "skipped" }]);
});

test("a heartbeat keeps the lease through a FETCH that outlasts it, so a Resume meanwhile starts no second run", async (t) => {
	let release;
	const fetchGate = new Promise((resolve) => (release = resolve));
	const inbox = Array.from({ length: 30 }, (_, index) => sampleMessage(index + 1, { subject: `Slow ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox }, fetchGate });
	t.after(() => release());
	const { db, env } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	const signIns = () => server.commands.filter((entry) => /^\S+ (LOGIN|AUTHENTICATE)\b/i.test(entry.line)).length;
	// A lease of a few seconds that the FETCH outlasts, as an eight-minute one is outlasted by a ten-minute command.
	const timing = { leaseMs: 3000, heartbeatMs: 300 };
	const first = processImportJob(env, job.id, CTX, timing);
	while (!server.commands.some((entry) => /UID FETCH/i.test(entry.line))) await sleep(20);
	assert.equal(await pauseImportJob(env, "owner", job.id), true);
	assert.equal(await resumeImportJob(env, "owner", job.id, { confirmed: false }), "resumed");
	await sleep(4500);
	const lease = () => db.db.prepare("SELECT lease_until FROM import_jobs").get().lease_until;
	assert.ok(lease() * 1000 > Date.now(), "the lease was renewed while the FETCH was open");
	const before = signIns();
	await processImportJob(env, job.id, CTX, timing);
	assert.equal(signIns(), before, "no second claim");
	release();
	await first;
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "completed");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 30);
	assert.equal(db.db.prepare("SELECT lease_until FROM import_jobs").get().lease_until, null);
});

test("the heartbeat renews only while the job is active or paused and never revives an ended one", async (t) => {
	let release;
	const fetchGate = new Promise((resolve) => (release = resolve));
	const server = await fake(t, { folders: { INBOX: [sampleMessage(1)] }, fetchGate });
	t.after(() => release());
	const { db, env } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	const first = processImportJob(env, job.id, CTX, { leaseMs: 3000, heartbeatMs: 200 });
	while (!server.commands.some((entry) => /UID FETCH/i.test(entry.line))) await sleep(20);
	assert.equal(await cancelImportJob(env, "owner", job.id), true);
	await sleep(700);
	const row = db.db.prepare("SELECT status, lease_until FROM import_jobs").get();
	assert.deepEqual(row, { status: "cancelled", lease_until: null });
	release();
	await first;
	assert.deepEqual(db.db.prepare("SELECT status, lease_until, password FROM import_jobs").get(), {
		status: "cancelled",
		lease_until: null,
		password: "",
	});
	assert.deepEqual(folderStatuses(db), [{ status: "skipped" }]);
});

test("a dead worker's job is reclaimed within the short lease after Resume, without the cron", async (t) => {
	const inbox = Array.from({ length: 30 }, (_, index) => sampleMessage(index + 1, { subject: `Dead ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox } });
	const { db, env, queued, delays } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	assert.ok(DEFAULT_IMPORT_TIMING.leaseMs <= 5 * 60_000, "a dead worker is found within minutes");
	assert.ok(
		DEFAULT_IMPORT_TIMING.heartbeatMs * 2 <= DEFAULT_IMPORT_TIMING.leaseMs,
		"a missed beat does not lose the lease",
	);
	assert.equal(await pauseImportJob(env, "owner", job.id), true);
	// A worker evicted mid-batch: the pause kept its lease and no heartbeat renews it any more.
	db.db.prepare("UPDATE import_jobs SET lease_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) + 2, job.id);
	queued.length = 0;
	delays.length = 0;
	assert.equal(await resumeImportJob(env, "owner", job.id, { confirmed: false }), "resumed");
	assert.deepEqual(queued, [
		{ kind: "import.imap", jobId: job.id },
		{ kind: "import.imap", jobId: job.id },
	]);
	assert.equal(delays[0], 0);
	assert.ok(delays[1] >= 2 && delays[1] <= 4, `${delays[1]}`);
	// Before the lease expires neither message starts a run beside the lease holder.
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
	await sleep(delays[1] * 1000 + 100);
	await processImportJob(env, job.id, CTX);
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "completed");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 30);
});

test("a database-full pause from a saved chunk keeps the lease until the open FETCH is finished", async (t) => {
	const inbox = Array.from({ length: 60 }, (_, index) => sampleMessage(index + 1, { subject: `Full ${index + 1}` }));
	const server = await fake(t, { folders: { INBOX: inbox }, fetchDelayMs: 600 });
	const { db, env, limits } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	limits.onPut = () => {
		limits.onPut = undefined;
		// From now on the database counts as full.
		delete env.KITE_RUNTIME;
		env.D1_MAX_BYTES = "1";
	};
	const run = processImportJob(env, job.id, CTX);
	const state = () => db.db.prepare("SELECT status, lease_until, pause_reason FROM import_jobs").get();
	while (state().status !== "paused") await sleep(10);
	assert.equal(state().pause_reason, "database");
	assert.notEqual(state().lease_until, null, "the open FETCH still holds the job");
	await run;
	assert.equal(state().lease_until, null, "the run's end released it");
});

test("another user's job cannot be paused, resumed or cancelled", async (t) => {
	const server = await fake(t, {});
	const { db, env } = await setup(t, server);
	const job = await startAccountJob(env, await planAccountImport(env, account));
	assert.equal(await pauseImportJob(env, "intruder", job.id), false);
	assert.equal(await pauseImportJob(env, "owner", job.id), true);
	assert.equal(await resumeImportJob(env, "intruder", job.id, { confirmed: false }), "not_found");
	assert.equal(await cancelImportJob(env, "intruder", job.id), false);
	assert.equal(db.db.prepare("SELECT status FROM import_jobs").get().status, "paused");
});

test("before migration 0076 folder jobs keep working and account jobs wait for the update", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "kite-migrations-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	cpSync(join(root, "drizzle/migrations"), directory, {
		recursive: true,
		filter: (source) => !source.endsWith("0076_add_import_job_folders.sql"),
	});
	const server = await fake(t, { folders: { INBOX: [sampleMessage(1, { subject: "Old schema" })] } });
	const { db, env } = await setup(t, server, directory);
	const job = await createImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "Inbox",
		destination: "system:inbox",
		...account,
		folder: "INBOX",
		maxMessages: null,
	});
	assert.equal(await drain(env, db, job.id), "completed");
	const [listed] = await listImportJobs(env, "owner");
	assert.deepEqual([listed.scope, listed.imported, listed.folders.length], ["folder", 1, 0]);
	assert.equal(await pauseImportJob(env, "owner", job.id), false);
	await assert.rejects(
		createAccountImportJob(env, {
			userId: "owner",
			mailboxId: "mailbox-a",
			label: "Whole account",
			...account,
			folders: [{ sourceName: "INBOX", role: "inbox", destination: "system:inbox", bytes: null }],
			gmail: false,
		}),
		ImportMigrationPendingError,
	);
});
