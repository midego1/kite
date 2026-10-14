import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	MODULE_MANIFESTS,
	MODULE_CAPABILITIES,
	importSchemas,
	createInvoker,
	createModuleBackground,
	runImportJob,
	resumeStalledImports,
	resumeStalledImportJobs,
	setModuleEnabled,
	setUserModuleAllowed,
	isModuleEnabled,
	isModuleEnabledFor,
	describeQueueMessage,
} = await bundleModules("kite-module-queue-cron-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["MODULE_MANIFESTS", "src/lib/modules/registry.ts"],
	["MODULE_CAPABILITIES", "src/lib/modules/capability-registry.ts"],
	["importSchemas", "src/lib/modules/import/schemas.ts"],
	["createInvoker", "src/lib/modules/invoke-utils.ts"],
	["createModuleBackground", "src/lib/modules/background-utils.ts"],
	["runImportJob, resumeStalledImports", "src/lib/import/background.ts"],
	["resumeStalledImportJobs", "src/lib/import/jobs.ts"],
	["setModuleEnabled, setUserModuleAllowed, isModuleEnabled, isModuleEnabledFor", "src/lib/modules/state.ts"],
	["describeQueueMessage", "worker-utils.ts"],
]);

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

const IMPORT_MESSAGE = { kind: "import.imap", jobId: "job-1" };

const JOB_COLUMNS =
	"id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, total, processed, imported, skipped, cursor_uid, attempts, lease_until, last_error, errors, created_at, updated_at, started_at, finished_at";

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1), ('member', 'member@example.com', 'hash', 'Member', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1), ('mailbox-b', 'member', 'domain-1', 'b', 'personal', 1);
	`);
	const queued = [];
	const env = {
		DB: db,
		BUCKET: { put: async () => undefined, get: async () => null, delete: async () => undefined },
		AGENT_QUEUE: { send: async (message, options) => queued.push({ message, options }) },
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, queued };
}

function insertJob(
	db,
	{ id = "job-1", userId = "owner", mailboxId = "mailbox-a", host = "imap.example.test", cursor = 120 } = {},
) {
	db.db
		.prepare(
			`INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, total, processed, imported, skipped, cursor_uid, attempts, last_error, errors, created_at, updated_at)
			VALUES (?, ?, ?, 'Old mail', 'system:inbox', ?, 993, 1, ?, 'sealed-password', 'INBOX', 'pending', 500, 40, 38, 2, ?, 1, 'earlier failure', '[]', 1, 1)`,
		)
		.run(id, userId, mailboxId, host, `${id}@source.test`, cursor);
}

const readJobs = (db) => db.db.prepare(`SELECT ${JOB_COLUMNS} FROM import_jobs ORDER BY id`).all();

/** The registry's real descriptors and schemas over handlers the test chooses and a module state it controls. */
function makeInvoker({ handlers, isEnabled, timeoutMs }) {
	return createInvoker({
		lookup: (moduleId, name) => {
			const descriptor = MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId)?.descriptors.find(
				(item) => item.name === name,
			);
			const schema = moduleId === "import" ? importSchemas[name] : null;
			const handler = handlers[`${moduleId}.${name}`];
			if (!descriptor || !schema || !handler) return null;
			return {
				descriptor: timeoutMs ? { ...descriptor, timeoutMs } : descriptor,
				inputSchema: schema.input,
				outputSchema: schema.output,
				handler,
			};
		},
		isEnabled,
		log: () => undefined,
	});
}

function makeBackground({ handlers = {}, off = [], manifests = MODULE_MANIFESTS, timeoutMs } = {}) {
	const logs = [];
	const calls = [];
	const wrapped = Object.fromEntries(
		Object.entries(handlers).map(([key, handler]) => [
			key,
			async (input, ctx) => {
				calls.push({ key, input, ctx });
				return handler(input, ctx);
			},
		]),
	);
	const invoke = makeInvoker({
		handlers: wrapped,
		isEnabled: async (_viewer, moduleId) => !off.includes(moduleId),
		timeoutMs,
	});
	const background = createModuleBackground({
		manifests,
		invoke,
		descriptorScopes: (moduleId, name) =>
			MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId)?.descriptors.find((item) => item.name === name)
				?.scopes ?? [],
		log: {
			debug: (message, fields) => logs.push({ level: "debug", message, ...fields }),
			info: (message, fields) => logs.push({ level: "info", message, ...fields }),
			warn: (message, fields) => logs.push({ level: "warn", message, ...fields }),
		},
	});
	return { background, logs, calls };
}

const ok = async () => ({});

test("import.imap on the agent queue reaches processImportJob with the message body and a queue context", async () => {
	const { background, calls } = makeBackground({ handlers: { "import.processImportJob": ok } });
	const outcome = await background.dispatchModuleQueueMessage({}, "agent", IMPORT_MESSAGE);
	assert.equal(outcome.handled, true);
	assert.equal(outcome.result.ok, true);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].input, IMPORT_MESSAGE);
	assert.equal(calls[0].ctx.trigger, "queue");
	assert.equal(calls[0].ctx.viewer, null);
	assert.deepEqual(calls[0].ctx.grants, ["import.run"]);
});

test("the deployed queue names kite-agent and a renamed -agent queue count as the agent queue", async () => {
	const { background, calls } = makeBackground({ handlers: { "import.processImportJob": ok } });
	assert.equal((await background.dispatchModuleQueueMessage({}, "kite-agent", IMPORT_MESSAGE)).handled, true);
	assert.equal((await background.dispatchModuleQueueMessage({}, "mailflare-agent", IMPORT_MESSAGE)).handled, true);
	assert.equal((await background.dispatchModuleQueueMessage({}, "kite-outbound", IMPORT_MESSAGE)).handled, false);
	assert.equal((await background.dispatchModuleQueueMessage({}, "xagent", IMPORT_MESSAGE)).handled, false);
	assert.equal(calls.length, 2);
});

test("core queue kinds, unknown kinds, other queues and malformed bodies are not handled", async () => {
	const { background, calls } = makeBackground({ handlers: { "import.processImportJob": ok } });
	const bodies = [
		["agent", { kind: "agent.triage", jobId: "j" }],
		["agent", { kind: "agent.draft", jobId: "j" }],
		["outbound", { kind: "email.scheduled", messageId: "m" }],
		["outbound", { kind: "backup.run", backupId: "b" }],
		["outbound", { kind: "mailbox.purge", mailboxId: "m" }],
		["outbound", { kind: "webhook.retry", deliveryId: "d" }],
		["inbound", { rawR2Key: "inbound/1-a.eml", from: "a", to: "b" }],
		["agent", { kind: "something.new", jobId: "j" }],
		["outbound", IMPORT_MESSAGE],
		["inbound", IMPORT_MESSAGE],
		["agent", null],
		["agent", "import.imap"],
		["agent", {}],
		["agent", { kind: 5 }],
	];
	for (const [queue, body] of bodies)
		assert.deepEqual(
			await background.dispatchModuleQueueMessage({}, queue, body),
			{ handled: false },
			JSON.stringify(body),
		);
	assert.deepEqual(calls, []);
});

test("with Import off the message is acked as module_disabled, the handler never runs and it is logged", async () => {
	const { background, calls, logs } = makeBackground({ handlers: { "import.processImportJob": ok }, off: ["import"] });
	const outcome = await background.dispatchModuleQueueMessage({}, "agent", IMPORT_MESSAGE);
	assert.equal(outcome.handled, true);
	assert.deepEqual(outcome.result, {
		ok: false,
		error: { code: "module_disabled", message: "This module is turned off" },
	});
	assert.deepEqual(calls, []);
	const entry = logs.find((item) => item.message === "queue.module_disabled");
	assert.ok(entry, "queue.module_disabled is logged");
	assert.equal(entry.moduleId, "import");
	assert.equal(entry.kind, "import.imap");
});

test("a handler that skips for a restricted owner is acked and logged as module_disabled too", async () => {
	const { background, logs } = makeBackground({
		handlers: { "import.processImportJob": async () => ({ skipped: "module_disabled" }) },
	});
	const outcome = await background.dispatchModuleQueueMessage({}, "agent", IMPORT_MESSAGE);
	assert.equal(outcome.handled, true);
	assert.ok(logs.some((item) => item.message === "queue.module_disabled" && item.moduleId === "import"));
});

test("a handler_error and a timeout are rethrown so the consumer retries", async () => {
	const failing = makeBackground({
		handlers: {
			"import.processImportJob": async () => {
				throw new Error("database is locked");
			},
		},
	});
	await assert.rejects(
		() => failing.background.dispatchModuleQueueMessage({}, "agent", IMPORT_MESSAGE),
		(error) => {
			assert.match(error.message, /import\.imap/);
			assert.equal(error.code, "handler_error");
			assert.doesNotMatch(error.message, /database is locked/);
			return true;
		},
	);

	const slow = makeBackground({
		handlers: { "import.processImportJob": () => new Promise((resolve) => setTimeout(() => resolve({}), 200)) },
		timeoutMs: 10,
	});
	await assert.rejects(
		() => slow.background.dispatchModuleQueueMessage({}, "agent", IMPORT_MESSAGE),
		(error) => {
			assert.equal(error.code, "timeout");
			return true;
		},
	);
});

test("a message the handler cannot ever accept is acked rather than retried", async () => {
	const { background, calls } = makeBackground({ handlers: { "import.processImportJob": ok } });
	const outcome = await background.dispatchModuleQueueMessage({}, "agent", { kind: "import.imap" });
	assert.equal(outcome.handled, true);
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error.code, "invalid_input");
	assert.deepEqual(calls, []);
});

test("over SQLite an import job row is unchanged after a message skipped because Import is off", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJob(db);
	const before = readJobs(db);
	await setModuleEnabled(env, { moduleId: "import", enabled: false, updatedBy: "owner" });

	const invoke = makeInvoker({
		handlers: { "import.processImportJob": (input, ctx) => runImportJob(env, ctx, input.jobId) },
		isEnabled: async (viewer, moduleId) =>
			viewer ? isModuleEnabledFor(env, viewer, moduleId) : isModuleEnabled(env, moduleId),
	});
	const background = createModuleBackground({
		manifests: MODULE_MANIFESTS,
		invoke,
		descriptorScopes: () => ["import.run"],
		log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
	});
	const outcome = await background.dispatchModuleQueueMessage(env, "agent", IMPORT_MESSAGE);
	assert.equal(outcome.result.error.code, "module_disabled");
	assert.deepEqual(readJobs(db), before);
	assert.deepEqual(queued, []);
});

test("the import handler skips a job whose owner is restricted and leaves the row byte for byte as it was", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJob(db);
	const before = readJobs(db);
	await setUserModuleAllowed(env, { userId: "owner", moduleId: "import", allowed: false, updatedBy: "member" });
	// The owner of a job is not the primary admin here, so the restriction applies.
	const ctx = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "queue" };
	assert.deepEqual(await runImportJob(env, ctx, "job-1"), { skipped: "module_disabled" });
	assert.deepEqual(readJobs(db), before);
	assert.deepEqual(queued, []);
});

test("the import handler runs a job whose owner is allowed and records the failed attempt", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJob(db);
	const ctx = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "queue" };
	assert.deepEqual(await runImportJob(env, ctx, "job-1"), {});
	const [job] = readJobs(db);
	assert.equal(job.attempts, 2, "the run counted its failed attempt");
	assert.equal(job.cursor_uid, 120);
	assert.equal(job.status, "running");
	assert.equal(queued.length, 1);
	assert.deepEqual(queued[0].message, IMPORT_MESSAGE);
	assert.equal(queued[0].options.delaySeconds, 60, "a retry is queued after a delay");
});

function cronBackground(handlers, extra = {}) {
	return makeBackground({ handlers, ...extra });
}

test("every_tick matches both cron expressions", async () => {
	const { background, calls } = cronBackground({ "import.resumeStalledImports": ok });
	await background.runModuleCronTasks({}, "*/5 * * * *", new Date(0));
	await background.runModuleCronTasks({}, "0 2 * * *", new Date(0));
	assert.deepEqual(
		calls.map((call) => call.key),
		["import.resumeStalledImports", "import.resumeStalledImports"],
	);
	assert.equal(calls[0].ctx.trigger, "cron");
	assert.equal(calls[0].ctx.viewer, null);
	assert.deepEqual(calls[0].input, {});
});

test("a cron task receives the tick time as scheduledTime, which Import's schema strips", async () => {
	const inputs = [];
	const background = createModuleBackground({
		manifests: [
			{
				id: "testmod",
				queueMessageTypes: [],
				cronTasks: [{ name: "tick", schedule: "every_tick", capability: "tick" }],
			},
		],
		invoke: async (_moduleId, _name, input) => {
			inputs.push(input);
			return { ok: true, output: {} };
		},
		descriptorScopes: () => [],
		log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
	});
	await background.runModuleCronTasks({}, "*/5 * * * *", new Date("2026-11-01T08:05:00.000Z"));
	assert.deepEqual(inputs, [{ scheduledTime: "2026-11-01T08:05:00.000Z" }]);
	assert.deepEqual(importSchemas.resumeStalledImports.input.parse(inputs[0]), {});
});

test("an exact schedule runs only on its own trigger and an unknown trigger runs nothing exact", async () => {
	const manifests = [
		{
			id: "import",
			queueMessageTypes: [],
			cronTasks: [
				{ name: "every", schedule: "every_tick", capability: "resumeStalledImports" },
				{ name: "five", schedule: "*/5 * * * *", capability: "resumeStalledImports" },
				{ name: "daily", schedule: "0 2 * * *", capability: "resumeStalledImports" },
			],
		},
	];
	const count = async (cron) => {
		const { background, calls } = cronBackground({ "import.resumeStalledImports": ok }, { manifests });
		await background.runModuleCronTasks({}, cron, new Date(0));
		return calls.length;
	};
	assert.equal(await count("*/5 * * * *"), 2);
	assert.equal(await count("0 2 * * *"), 2);
	assert.equal(await count("30 4 * * *"), 1);
});

test("a disabled module's cron task is skipped and logged at debug level", async () => {
	const { background, calls, logs } = cronBackground({ "import.resumeStalledImports": ok }, { off: ["import"] });
	await background.runModuleCronTasks({}, "*/5 * * * *", new Date(0));
	assert.deepEqual(calls, []);
	const entry = logs.find((item) => item.message === "cron.module_disabled");
	assert.equal(entry?.level, "debug");
	assert.equal(entry?.moduleId, "import");
});

test("one failing cron task is logged and does not stop the others", async () => {
	const task = (name) => ({ name, schedule: "every_tick", capability: "resumeStalledImports" });
	const manifests = [
		{ id: "import", queueMessageTypes: [], cronTasks: [task("first")] },
		{ id: "import", queueMessageTypes: [], cronTasks: [task("second")] },
	];
	let runs = 0;
	const { background, calls, logs } = cronBackground(
		{
			"import.resumeStalledImports": async () => {
				runs += 1;
				if (runs === 1) throw new Error("first broke");
				return {};
			},
		},
		{ manifests },
	);
	await assert.doesNotReject(() => background.runModuleCronTasks({}, "*/5 * * * *", new Date(0)));
	assert.equal(calls.length, 2, "both tasks ran");
	const failed = logs.filter((item) => item.message === "cron.task_failed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0].level, "warn");
	assert.equal(failed[0].code, "handler_error");
});

test("a cron task whose invoker throws is isolated too", async () => {
	const manifests = [
		{
			id: "import",
			queueMessageTypes: [],
			cronTasks: [{ name: "broken", schedule: "every_tick", capability: "resumeStalledImports" }],
		},
		{
			id: "import",
			queueMessageTypes: [],
			cronTasks: [{ name: "fine", schedule: "every_tick", capability: "resumeStalledImports" }],
		},
	];
	const ran = [];
	const background = createModuleBackground({
		manifests,
		descriptorScopes: () => [],
		invoke: async (_moduleId, name) => {
			ran.push(name);
			if (ran.length === 1) throw new Error("invoker exploded");
			return { ok: true, output: {} };
		},
		log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
	});
	await assert.doesNotReject(() => background.runModuleCronTasks({}, "0 2 * * *", new Date(0)));
	assert.equal(ran.length, 2);
});

function cronOver(env) {
	const invoke = makeInvoker({
		handlers: { "import.resumeStalledImports": (_input, ctx) => resumeStalledImports(env, ctx) },
		isEnabled: async (viewer, moduleId) =>
			viewer ? isModuleEnabledFor(env, viewer, moduleId) : isModuleEnabled(env, moduleId),
	});
	return createModuleBackground({
		manifests: MODULE_MANIFESTS,
		invoke,
		descriptorScopes: () => ["import.run"],
		log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
	});
}

test("the stalled-import cron does nothing while Import is off and re-queues the stalled job once it is on", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJob(db);
	const before = readJobs(db);
	const background = cronOver(env);

	await setModuleEnabled(env, { moduleId: "import", enabled: false, updatedBy: "owner" });
	await background.runModuleCronTasks(env, "*/5 * * * *", new Date());
	assert.deepEqual(queued, [], "nothing is re-queued while Import is off");
	assert.deepEqual(readJobs(db), before);

	await setModuleEnabled(env, { moduleId: "import", enabled: true, updatedBy: "owner" });
	await background.runModuleCronTasks(env, "*/5 * * * *", new Date());
	assert.deepEqual(
		queued.map((entry) => entry.message),
		[IMPORT_MESSAGE],
	);
	assert.deepEqual(readJobs(db), before, "re-queueing leaves the cursor and the attempt count to the next run");
	assert.equal(readJobs(db)[0].cursor_uid, 120);
});

test("the resume handler leaves out jobs of restricted owners and jobs that are not stalled", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJob(db, { id: "job-owner", userId: "owner", mailboxId: "mailbox-a", host: "imap.one.test" });
	insertJob(db, { id: "job-member", userId: "member", mailboxId: "mailbox-b", host: "imap.two.test" });
	insertJob(db, { id: "job-fresh", userId: "owner", mailboxId: "mailbox-a", host: "imap.three.test" });
	db.db.prepare("UPDATE import_jobs SET updated_at = ? WHERE id = 'job-fresh'").run(Math.floor(Date.now() / 1000));
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	const before = readJobs(db);

	const ctx = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "cron" };
	assert.deepEqual(await resumeStalledImports(env, ctx), {});
	assert.deepEqual(
		queued.map((entry) => entry.message.jobId),
		["job-owner"],
	);
	assert.deepEqual(readJobs(db), before);
});

test("a restricted owner's jobs do not hide an allowed owner's job behind the batch limit", async (t) => {
	const { db, env, queued } = await setup(t);
	for (let index = 0; index < 12; index += 1)
		insertJob(db, {
			id: `job-r${String(index).padStart(2, "0")}`,
			userId: "member",
			mailboxId: "mailbox-b",
			host: `imap.m${index}.test`,
		});
	insertJob(db, { id: "job-z", userId: "owner", mailboxId: "mailbox-a", host: "imap.owner.test" });
	db.db.prepare("UPDATE import_jobs SET created_at = 50 WHERE id = 'job-z'").run();
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	const ctx = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "cron" };
	await resumeStalledImports(env, ctx);
	assert.deepEqual(
		queued.map((entry) => entry.message.jobId),
		["job-z"],
	);
});

function insertJobsInBulk(db, count, { prefix, userId, mailboxId, createdAt }) {
	const statement = db.db.prepare(
		`INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, total, processed, imported, skipped, cursor_uid, attempts, errors, created_at, updated_at)
		VALUES (?, ?, ?, 'Old mail', 'system:inbox', ?, 993, 1, ?, 'sealed-password', 'INBOX', 'pending', 500, 40, 38, 2, 1, 1, '[]', ?, 1)`,
	);
	for (let index = 0; index < count; index += 1) {
		const id = `${prefix}${String(index).padStart(4, "0")}`;
		statement.run(id, userId, mailboxId, `imap.${id}.test`, `${id}@source.test`, createdAt);
	}
}

const cronCtx = {
	viewer: null,
	requestId: "r",
	locale: "en",
	timeZone: "UTC",
	grants: ["import.run"],
	trigger: "cron",
};

test("more than a window of older restricted jobs does not starve a newer allowed owner's job", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJobsInBulk(db, 450, { prefix: "job-r", userId: "member", mailboxId: "mailbox-b", createdAt: 10 });
	insertJob(db, { id: "job-allowed", userId: "owner", mailboxId: "mailbox-a", host: "imap.allowed.test" });
	db.db.prepare("UPDATE import_jobs SET created_at = 500 WHERE id = 'job-allowed'").run();
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	const before = readJobs(db);

	await resumeStalledImports(env, cronCtx);
	assert.deepEqual(
		queued.map((entry) => entry.message.jobId),
		["job-allowed"],
	);
	assert.deepEqual(
		readJobs(db).filter((job) => job.id.startsWith("job-r")),
		before.filter((job) => job.id.startsWith("job-r")),
		"restricted jobs stay untouched",
	);
});

test("paging past a window keeps jobs that share one created_at in order and asks each owner once", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJobsInBulk(db, 205, { prefix: "job-a", userId: "member", mailboxId: "mailbox-b", createdAt: 10 });
	insertJobsInBulk(db, 3, { prefix: "job-b", userId: "owner", mailboxId: "mailbox-a", createdAt: 10 });
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	const asked = [];
	await resumeStalledImportJobs(env, cronCtx, async (userId) => {
		asked.push(userId);
		return userId === "owner";
	});
	assert.deepEqual(asked.sort(), ["member", "owner"]);
	assert.deepEqual(
		queued.map((entry) => entry.message.jobId),
		["job-b0000", "job-b0001", "job-b0002"],
	);
});

test("a tick resumes at most ten jobs", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJobsInBulk(db, 25, { prefix: "job-ok", userId: "owner", mailboxId: "mailbox-a", createdAt: 10 });
	await resumeStalledImports(env, cronCtx);
	assert.equal(queued.length, 10);
});

test("a tick pages through a bounded number of rows, so a far-away allowed job waits for a later tick", async (t) => {
	const { db, env, queued } = await setup(t);
	insertJobsInBulk(db, 2500, { prefix: "job-x", userId: "member", mailboxId: "mailbox-b", createdAt: 5 });
	insertJobsInBulk(db, 1, { prefix: "job-late", userId: "owner", mailboxId: "mailbox-a", createdAt: 9000 });
	let asked = 0;
	await resumeStalledImportJobs(env, cronCtx, async (userId) => {
		asked += 1;
		return userId === "owner";
	});
	assert.equal(asked, 1, "each owner is asked once across pages");
	assert.deepEqual(queued, []);
});

test("the queue metric class of import.imap comes from the manifest and core kinds stay literal", () => {
	assert.equal(describeQueueMessage({ kind: "import.imap", jobId: "j" }).kind, "import");
	assert.equal(describeQueueMessage({ kind: "agent.triage" }).kind, "agent_triage");
	assert.equal(describeQueueMessage({ kind: "backup.run" }).kind, "backup");
	assert.equal(describeQueueMessage({ kind: "nope" }).kind, "unknown");
	assert.equal(describeQueueMessage({ kind: "toString" }).kind, "unknown");
	const manifest = MODULE_MANIFESTS.find((item) => item.id === "import");
	assert.equal(manifest.queueMessageTypes[0].metricClass, "import");
});

const read = (file) => readFileSync(join(root, file), "utf8");
const ENTRYPOINTS = ["worker.ts", "worker-utils.ts", "server/index.ts", "server/runtime/scheduler.ts"];

test("entrypoints and the scheduler hold no per-module code", () => {
	for (const file of ENTRYPOINTS) {
		const source = read(file);
		assert.doesNotMatch(source, /@\/lib\/(import|calendar|booking)\b|\/lib\/(import|calendar|booking)\//, file);
		assert.doesNotMatch(source, /lib\/modules\/(calendar|booking|templates|import)\b/, file);
		assert.doesNotMatch(source, /processImportJob|isImportJobQueueMessage|resumeStalledImportJobs/, file);
	}
});

test("worker.ts and the Node server route module messages and cron through the registry", () => {
	const worker = read("worker.ts");
	assert.match(worker, /dispatchModuleQueueMessage\(env, batch\.queue, msg\.body\)/);
	assert.match(worker, /runModuleCronTasks\(env, controller\.cron, new Date\(controller\.scheduledTime\)\)/);
	const server = read("server/index.ts");
	for (const queue of ["inbound", "outbound", "agent"])
		assert.match(server, new RegExp(`dispatchModuleQueueMessage\\(env, "${queue}", body\\)`), queue);
});

test("the Node scheduler runs module cron tasks every five minutes and with the daily backup", () => {
	const scheduler = read("server/runtime/scheduler.ts");
	assert.match(scheduler, /runModuleCronTasks\(env, "\*\/5 \* \* \* \*", now\)/);
	assert.match(scheduler, /runModuleCronTasks\(env, "0 2 \* \* \*", now\)/);
});
