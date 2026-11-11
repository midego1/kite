import assert from "node:assert/strict";
import test from "node:test";
import { APP_ORIGIN, loadStorageServices } from "./support/storage-services.mjs";

const { lib, fake, fixture, addStore } = await loadStorageServices(
	"kite-storage-leftovers-",
	["kite-c", "kite-d", "kite-e"],
	{
		cold: "src/lib/storage/cold.ts",
		router: "src/lib/storage/router.ts",
		storageIndex: "src/lib/storage/index.ts",
		objectLocations: "src/lib/storage/object-locations.ts",
		coldMove: "src/lib/storage/cold-move.ts",
		coldLeftovers: "src/lib/storage/cold-leftovers.ts",
		leftoverState: "src/lib/storage/cold-leftovers-state.ts",
		migrationPurge: "src/lib/storage/migration-purge.ts",
		leftoversRoute: "src/app/api/admin/storage/leftovers/route.ts",
	},
);
const { cold, coldLeftovers, coldMove, leftoverState, objectLocations, migrationPurge, stores } = lib;
const { getStorage } = lib.storageIndex;

// Leases run on the real clock (the movers', the purge's and the cleanup's alike), so every time here is relative
// to the real now; `at(days)` is what the cleanup and maintenance are told the time is.
const DAY = 24 * 60 * 60;
const NOW = Math.floor(Date.now() / 1000);
const at = (days) => new Date((NOW + days * DAY) * 1000);
const BUCKETS = { sto_c: "kite-c", sto_d: "kite-d", sto_e: "kite-e" };
const KEY = "inbound/m.eml";
const CONTENT = "the one message everybody must still be able to read";

async function setup(t) {
	const { env, queue } = await fixture(t);
	for (const [id, bucket] of Object.entries(BUCKETS)) await addStore(env, id, bucket);
	return { env, queue };
}

async function put(env, storeId, key, content) {
	if (storeId === "default") return void (await env.BUCKET.put(key, content));
	fake.buckets.get(BUCKETS[storeId]).objects.set(key, {
		bytes: Buffer.from(content),
		meta: { custom: {} },
		etag: `e-${storeId}-${content.length}`,
		lastModified: new Date(),
	});
}

async function text(env, storeId, key) {
	if (storeId === "default") {
		const object = await env.BUCKET.get(key);
		return object ? await object.text() : null;
	}
	const object = fake.buckets.get(BUCKETS[storeId])?.objects.get(key);
	return object ? Buffer.from(object.bytes).toString("utf8") : null;
}

const has = async (env, storeId, key) => (await text(env, storeId, key)) !== null;

function addMessageRow(env, id, key = `inbound/${id}.eml`) {
	env.DB.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			 VALUES (?, 'owner', 'mailbox-a', 'inbound', 'sender@example.net', 'a@example.com', 'Hello', 'received', ?, ?)`,
		)
		.run(id, key, NOW - 90 * DAY);
	return key;
}

function setLocation(
	env,
	key,
	storeId,
	{ objectClass = "mail", movedAt = NOW - 60 * DAY, size = CONTENT.length } = {},
) {
	env.DB.db
		.prepare(
			`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, ?, ?, NULL, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET store_id = excluded.store_id`,
		)
		.run(key, objectClass, storeId, size, movedAt);
}

let candidates = 0;
function markLeftover(
	env,
	storeId,
	key,
	{
		objectClass = "mail",
		movedAt = NOW - 60 * DAY,
		firstOrphanedAt = NOW - 30 * DAY,
		unreferencedSince = null,
		orphanedAt = firstOrphanedAt,
	} = {},
) {
	const id = `sco_t${++candidates}`;
	env.DB.db
		.prepare(
			`INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at, unreferenced_since)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(id, storeId, key, objectClass, movedAt, orphanedAt, firstOrphanedAt, unreferencedSince);
	return id;
}

function addBackup(env, id, { createdAt, completedAt = createdAt + 60, status = "completed", trigger = "scheduled" }) {
	env.DB.db
		.prepare(
			"INSERT INTO backups (id, status, `trigger`, r2_key, filename, size, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
		)
		.run(
			id,
			status,
			trigger,
			`backups/database/${id}/${id}.json`,
			`${id}.json`,
			createdAt,
			status === "completed" ? completedAt : null,
		);
}

const location = (env, key) => env.DB.db.prepare("SELECT * FROM object_locations WHERE key = ?").get(key);
const leftover = (env, key, storeId) =>
	env.DB.db.prepare("SELECT * FROM storage_cold_orphans WHERE key = ? AND store_id = ?").get(key, storeId);
const lapse = (env, key) => env.DB.db.prepare("UPDATE object_locations SET claimed_until = 0 WHERE key = ?").run(key);

function cleanup(env, { days = 0, storeId = null, trigger = "manual" } = {}) {
	return coldLeftovers.purgeLeftovers(env, { trigger, storeId, limit: 50, now: at(days) });
}

async function routedText(env, key) {
	const object = await lib.router.createStorageRouter(env).get(key);
	return object ? await object.text() : null;
}

/** The invariant every scenario must keep: the router reads the bytes, and a location row names a store that has them. */
async function assertReadable(env, key, content, label) {
	assert.equal(await routedText(env, key), content, `${label}: the router reads the object`);
	const row = location(env, key);
	if (row && !row.lease_token?.startsWith("ptmp_"))
		assert.equal(await text(env, row.store_id, key), content, `${label}: the location names a store that has it`);
}

/** Runs `during` once, the first time `storeId`'s bucket `method` is called for `key`, before the call itself. */
async function onStore(env, storeId, method, key, during) {
	const bucket = (await getStorage(env)).store(storeId).bucket;
	const original = bucket[method].bind(bucket);
	let fired = false;
	bucket[method] = async (target, ...rest) => {
		if (!fired && target === key) {
			fired = true;
			await during();
		}
		return original(target, ...rest);
	};
	return () => fired;
}

/** Runs `during` once, right before the first statement whose SQL contains `fragment` executes. */
function onStatement(env, fragment, during) {
	const prepare = env.DB.prepare.bind(env.DB);
	let fired = false;
	env.DB.prepare = (sql) => {
		const statement = prepare(sql);
		if (fired || !sql.includes(fragment)) return statement;
		const bind = statement.bind.bind(statement);
		const hook = (target) => {
			for (const method of ["run", "first", "all"]) {
				const call = target[method].bind(target);
				target[method] = async (...args) => {
					if (!fired) {
						fired = true;
						env.DB.prepare = prepare;
						await during();
					}
					return call(...args);
				};
			}
			return target;
		};
		statement.bind = (...values) => hook(bind(...values));
		return hook(statement);
	};
	return () => fired;
}

/** Runs `during` once, right after the first statement whose SQL contains `fragment` has executed. */
function onStatementAfter(env, fragment, during) {
	const prepare = env.DB.prepare.bind(env.DB);
	let fired = false;
	env.DB.prepare = (sql) => {
		const statement = prepare(sql);
		if (fired || !sql.includes(fragment)) return statement;
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			const bound = bind(...values);
			const run = bound.run.bind(bound);
			bound.run = async (...args) => {
				const result = await run(...args);
				if (!fired) {
					fired = true;
					env.DB.prepare = prepare;
					await during();
				}
				return result;
			};
			return bound;
		};
		return statement;
	};
	return () => fired;
}

/** Routes a class to a store directly, as a finished route switch leaves it. */
function routeTo(env, objectClass, storeId) {
	env.DB.db
		.prepare(
			"INSERT INTO storage_routes (object_class, store_id, previous_store_id, updated_at) VALUES (?, ?, NULL, 1)",
		)
		.run(objectClass, storeId);
	lib.config.clearStorageConfigCache();
}

const mailRule = (target) => ({ objectClass: "mail", afterDays: 30, minBytes: 0, target });
const mailItem = (key = KEY) => ({ id: "m", key, size: CONTENT.length, createdAt: new Date((NOW - 90 * DAY) * 1000) });

/** A cold move of KEY to `target`, as a stale sweep batch would run it; a refusal is part of the outcome, not a failure. */
async function move(env, target, key = KEY) {
	try {
		await coldMove.moveColdObject(env, await getStorage(env), "mail", mailRule(target), mailItem(key));
		return "moved";
	} catch (error) {
		return error.message;
	}
}

async function purge(env, fromId, toId, key = KEY) {
	const storage = await getStorage(env);
	try {
		await migrationPurge.purgeOldCopy(env, storage.store(fromId), storage.store(toId), "mail", {
			key,
			size: CONTENT.length,
		});
		return "purged";
	} catch (error) {
		return error.message;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The plain decisions, one at a time.
// ---------------------------------------------------------------------------------------------------------------

test("a superseded leftover is deleted once its live copy reads back; the live copy and the row stay", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);

	const run = await cleanup(env);
	assert.equal(run.deleted, 1, JSON.stringify(run));
	assert.equal(await has(env, "sto_c", KEY), false, "the leftover is gone");
	assert.equal(leftover(env, KEY, "sto_c"), undefined, "and so is its tracking row");
	assert.equal(location(env, KEY).store_id, "sto_d");
	assert.equal(location(env, KEY).lease_token, null, "the claim was released");
	await assertReadable(env, KEY, CONTENT, "after the cleanup");
});

test("the copy a live location names is never deleted, only its tracking row is dropped", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY);

	const run = await cleanup(env);
	assert.deepEqual([run.deleted, run.cleared], [0, 1]);
	assert.equal(await has(env, "sto_c", KEY), true);
	assert.equal(leftover(env, KEY, "sto_c"), undefined);
	await assertReadable(env, KEY, CONTENT, "live copy");
});

test("a superseded leftover is kept while its live copy cannot be read back, or reads back a different size", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);

	let run = await cleanup(env);
	assert.deepEqual(run.kept, { only_copy: 1 }, "the live location is empty: this is the only copy");
	assert.equal(await has(env, "sto_c", KEY), true);
	assert.equal(leftover(env, KEY, "sto_c").kept_reason, "only_copy", "the reason is recorded for Admin → Storage");

	await put(env, "sto_d", KEY, "truncated");
	run = await cleanup(env);
	assert.deepEqual(run.kept, { only_copy: 1 }, "a copy of another size is not proof");
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("a live copy of the same size but other bytes is not proof: the leftover is kept (review of #479, P4)", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT.replace("one", "two"));
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { unverified: 1 });
	assert.equal(await text(env, "sto_c", KEY), CONTENT);
	assert.equal(leftover(env, KEY, "sto_c").kept_reason, "unverified");
});

test("an object too large to hash is only confirmed by equal ETags on both stores", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	const large = "x".repeat(9 * 1024 * 1024);
	await put(env, "sto_d", KEY, large);
	setLocation(env, KEY, "sto_d", { size: large.length });
	await put(env, "sto_c", KEY, large);
	markLeftover(env, "sto_c", KEY);
	let run = await cleanup(env);
	assert.deepEqual(run.kept, { unverified: 1 }, "different ETags, too large to compare byte for byte");
	assert.equal(await has(env, "sto_c", KEY), true);
	for (const storeId of ["sto_c", "sto_d"])
		fake.buckets.get(BUCKETS[storeId]).objects.get(KEY).etag = "0123456789abcdef0123456789abcdef";
	run = await cleanup(env);
	assert.equal(run.deleted, 1, JSON.stringify(run));
	assert.equal(await has(env, "sto_c", KEY), false);
	assert.equal(await has(env, "sto_d", KEY), true);
});

test("a key with no location row gets a claim row naming where its bytes are now, and it is gone afterwards", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "default", KEY, CONTENT);
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);

	let claimRow = null;
	await onStore(env, "sto_c", "head", KEY, async () => {
		claimRow = location(env, KEY);
	});
	const run = await cleanup(env);
	assert.equal(run.deleted, 1);
	assert.equal(claimRow.store_id, "default", "the claim row names the store the bytes are on, never the leftover's");
	assert.match(claimRow.lease_token, /^ptmp_/);
	assert.equal(location(env, KEY), undefined, "a key that had no row has none afterwards (no lying row, B5)");
	assert.equal(await has(env, "sto_c", KEY), false);
	await assertReadable(env, KEY, CONTENT, "row-less key");
});

test("a referenced key with no location row whose only copy is the leftover keeps it, and logs why", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);

	const run = await cleanup(env);
	assert.deepEqual(run.kept, { only_copy: 1 });
	assert.equal(await has(env, "sto_c", KEY), true);
	assert.equal(location(env, KEY), undefined, "the claim row naming the leftover's own store is removed again");
});

test("an unreferenced copy is deleted only after it has been seen unreferenced for the grace period, with its row", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	// Marked the way the five-minute scan marks it, run after run: the grace period must still run out (the scan's
	// own repeated marks never push it back).
	for (let day = 0; day <= 9; day += 1) await cold.runStorageColdMaintenance(env, at(day));
	const row = leftover(env, KEY, "sto_c");
	assert.equal(row.unreferenced_since, NOW, "first sighting");
	assert.equal(row.first_orphaned_at, NOW, "not bumped by later scans");

	let run = await cleanup(env, { days: 6 });
	assert.equal(run.checked, 0, "inside the grace period it is not even looked at");
	run = await cleanup(env, { days: 8 });
	assert.equal(run.deleted, 1, JSON.stringify(run));
	assert.equal(await has(env, "sto_c", KEY), false);
	assert.equal(location(env, KEY), undefined, "the row of an object nothing uses goes with it");
});

test("an unreferenced copy a leftover check sees first starts its own grace period before anything is deleted", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	let run = await cleanup(env);
	assert.deepEqual(run.kept, { confirming: 1 });
	assert.equal(leftover(env, KEY, "sto_c").unreferenced_since, NOW);
	run = await cleanup(env, { days: 3 });
	assert.deepEqual(run.kept, { confirming: 1 });
	run = await cleanup(env, { days: 8 });
	assert.equal(run.deleted, 1);
});

test("a young leftover is untouched by the manual action", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY, { firstOrphanedAt: NOW - 2 * DAY });
	const run = await cleanup(env);
	assert.equal(run.checked, 0);
	assert.equal(await has(env, "sto_c", KEY), true);
	assert.equal(run.remaining, 1, "the response says what is still tracked");
});

test("a backup created in the very second a key was first seen unreferenced still keeps its copy (review of #479, P5)", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	addBackup(env, "bak_same_second", { createdAt: NOW - 20 * DAY });
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { backup: 1 });
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("a superseded leftover is kept while a retained backup from when it was the location could restore that row", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY, { movedAt: NOW - 60 * DAY, firstOrphanedAt: NOW - 30 * DAY });
	addBackup(env, "bak_inside", { createdAt: NOW - 40 * DAY });
	addBackup(env, "bak_before", { createdAt: NOW - 70 * DAY, completedAt: NOW - 70 * DAY + 60 });
	addBackup(env, "bak_after", { createdAt: NOW - 20 * DAY });

	let run = await cleanup(env);
	assert.deepEqual(run.kept, { backup: 1 });
	assert.equal(await has(env, "sto_c", KEY), true);

	env.DB.db.prepare("DELETE FROM backups WHERE id = 'bak_inside'").run();
	run = await cleanup(env);
	assert.equal(run.deleted, 1, "backups before or after the window hold no row naming this copy");
});

test("an unreferenced copy is kept while any retained backup, a safety backup included, predates its unreferenced stretch", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	addBackup(env, "bak_safety", { createdAt: NOW - 25 * DAY, trigger: "pre-restore" });
	addBackup(env, "bak_later", { createdAt: NOW - 10 * DAY });

	let run = await cleanup(env);
	assert.deepEqual(run.kept, { backup: 1 }, "the safety backup can bring the message back");
	assert.equal(await has(env, "sto_c", KEY), true);

	// A backup still running counts too: it may be copying the reference right now.
	env.DB.db.prepare("DELETE FROM backups WHERE id = 'bak_safety'").run();
	addBackup(env, "bak_running", { createdAt: NOW - 21 * DAY, status: "running" });
	run = await cleanup(env);
	assert.deepEqual(run.kept, { backup: 1 });

	env.DB.db.prepare("DELETE FROM backups WHERE id = 'bak_running'").run();
	run = await cleanup(env);
	assert.equal(run.deleted, 1);
});

test("a restore after a leftover was first seen unreferenced starts its unreferenced stretch over", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	// First seen unreferenced 30 days ago; a restore 20 days ago brought the message back, a backup 15 days ago
	// saw it referenced, and it was deleted again since. That backup can restore it: the copy must stay.
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 30 * DAY });
	await env.BUCKET.put(
		"system/backup-restore.json",
		JSON.stringify({
			id: "rst_1",
			status: "completed",
			needsRecovery: false,
			finishedAt: new Date((NOW - 20 * DAY) * 1000).toISOString(),
			updatedAt: new Date((NOW - 20 * DAY) * 1000).toISOString(),
		}),
	);
	addBackup(env, "bak_referenced", { createdAt: NOW - 15 * DAY });

	let run = await cleanup(env);
	assert.deepEqual(run.kept, { confirming: 1 }, "the old sighting proves nothing any more");
	assert.equal(leftover(env, KEY, "sto_c").unreferenced_since, NOW);
	run = await cleanup(env, { days: 8 });
	assert.deepEqual(run.kept, { backup: 1 }, "the backup taken after the restore keeps it");
	assert.equal(await has(env, "sto_c", KEY), true);
	env.DB.db.prepare("DELETE FROM backups").run();
	run = await cleanup(env, { days: 8 });
	assert.equal(run.deleted, 1);
});

test("a referenced key clears an earlier unreferenced sighting", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	addBackup(env, "bak_inside", { createdAt: NOW - 40 * DAY });
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { backup: 1 });
	assert.equal(leftover(env, KEY, "sto_c").unreferenced_since, null);
});

test("a send still queued with the key in its payload counts as a reference", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	env.DB.db
		.prepare(
			"INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES ('job_1', 'owner', 'queued', ?, 1, 1)",
		)
		.run(JSON.stringify({ attachments: [{ key: KEY }] }));
	const run = await cleanup(env);
	assert.deepEqual([run.deleted, run.cleared], [0, 1], "the live location of a referenced key");
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("a superseded leftover on a store a cold rule or in-flight sweep archives into is kept", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_rules (object_class, after_days, min_bytes, target, enabled, updated_at) VALUES ('mail', 30, 0, 'sto_c', 1, 1)",
		)
		.run();
	let run = await cleanup(env);
	assert.deepEqual(run.kept, { cold_target: 1 });

	env.DB.db.prepare("UPDATE storage_cold_rules SET enabled = 0").run();
	const cursor = JSON.stringify({ rule: mailRule("sto_c"), cutoff: 0, sources: {} });
	env.DB.db
		.prepare(
			"INSERT INTO storage_cold_jobs (object_class, status, cursor, created_at) VALUES ('mail', 'running', ?, 1)",
		)
		.run(cursor);
	run = await cleanup(env);
	assert.deepEqual(run.kept, { cold_target: 1 }, "a sweep still in flight keeps its rule as it started");
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("a leftover on a store a storage migration uses is kept", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	env.DB.db
		.prepare(
			`INSERT INTO storage_migrations (id, object_class, from_store_id, to_store_id, status, created_by_user_id, created_at)
			 VALUES ('mig_1', 'mail', 'sto_c', 'default', 'copying', 'owner', 1)`,
		)
		.run();
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { migrating: 1 });
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("Drive: a copy on the store the file's own row names is live even when object_locations names another (a restored row, B1)", async (t) => {
	const { env } = await setup(t);
	const key = "drive/drv_1";
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES ('drv_1', 'owner', 'file', 'a.txt', ?, 'sto_c', ?, 'ready', 1, 1)`,
		)
		.run(CONTENT.length, key);
	await put(env, "sto_c", key, CONTENT);
	await put(env, "sto_d", key, CONTENT);
	setLocation(env, key, "sto_d", { objectClass: "drive" });
	markLeftover(env, "sto_c", key, { objectClass: "drive" });
	const run = await cleanup(env);
	assert.deepEqual([run.deleted, run.cleared], [0, 1]);
	assert.equal(await has(env, "sto_c", key), true, "Drive reads its own row's store first");
	assert.equal(await has(env, "sto_d", key), true);
});

test("Drive: a file row without a store reads the default store, so a copy there is live (review of #479, P1)", async (t) => {
	const { env } = await setup(t);
	const key = "drive/drv_1";
	routeTo(env, "drive", "sto_d");
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES ('drv_1', 'owner', 'file', 'a.txt', ?, NULL, ?, 'ready', 1, 1)`,
		)
		.run(CONTENT.length, key);
	await put(env, "default", key, CONTENT);
	await put(env, "sto_d", key, CONTENT);
	markLeftover(env, "default", key, { objectClass: "drive" });
	const run = await cleanup(env);
	assert.deepEqual([run.deleted, run.cleared], [0, 1]);
	assert.equal(await has(env, "default", key), true, "the only copy Drive itself reads");
});

test("Drive: a leftover neither the file's row nor its location names is deleted after its live copy reads back", async (t) => {
	const { env } = await setup(t);
	const key = "drive/drv_1";
	env.DB.db
		.prepare(
			`INSERT INTO drive_items (id, owner_id, kind, name, size, store_id, object_key, status, created_at, updated_at)
			 VALUES ('drv_1', 'owner', 'file', 'a.txt', ?, 'sto_d', ?, 'ready', 1, 1)`,
		)
		.run(CONTENT.length, key);
	await put(env, "sto_d", key, CONTENT);
	setLocation(env, key, "sto_d", { objectClass: "drive" });
	await put(env, "default", key, CONTENT);
	markLeftover(env, "default", key, { objectClass: "drive" });
	const run = await cleanup(env, { storeId: "default" });
	assert.equal(run.deleted, 1, "candidates on the default store can be cleaned up too (m4)");
	assert.equal(await has(env, "default", key), false);
	assert.equal(await has(env, "sto_d", key), true);
});

test("nothing is deleted while a restore runs, needs recovery or has just finished", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	const job = (fields) =>
		env.BUCKET.put(
			"system/backup-restore.json",
			JSON.stringify({
				id: "rst_1",
				needsRecovery: false,
				finishedAt: null,
				updatedAt: new Date().toISOString(),
				...fields,
			}),
		);
	for (const fields of [
		{ status: "restoring" },
		{ status: "failed", needsRecovery: true, finishedAt: new Date((NOW - 30 * DAY) * 1000).toISOString() },
		{ status: "completed", finishedAt: new Date().toISOString() },
	]) {
		await job(fields);
		const run = await cleanup(env);
		assert.equal(run.skipped, "restore", JSON.stringify(fields));
		assert.equal(await has(env, "sto_c", KEY), true);
	}
	// A full backup's objects being copied back counts as a restore too.
	await job({ status: "completed", finishedAt: new Date((NOW - 30 * DAY) * 1000).toISOString() });
	addBackup(env, "bak_old", { createdAt: NOW - 40 * DAY });
	env.DB.db.prepare("DELETE FROM backups").run();
	env.DB.db
		.prepare(
			"INSERT INTO backups (id, status, `trigger`, r2_key, filename, size, created_at, completed_at, objects_status) VALUES ('bak_obj', 'completed', 'manual', 'backups/database/bak_obj/x.json', 'x.json', 1, ?, ?, 'restoring')",
		)
		.run(NOW - 5 * DAY, NOW - 5 * DAY);
	const run = await cleanup(env);
	assert.equal(run.skipped, "restore");
	assert.equal(await has(env, "sto_c", KEY), true);
});

test("a restore that starts while the cleanup runs stops it before the next delete", async (t) => {
	const { env } = await setup(t);
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
	const fired = onStatement(env, "claimed_until >= ? AND store_id = ?", async () => undefined);
	await onStore(env, "sto_c", "head", KEY, () =>
		env.BUCKET.put(
			"system/backup-restore.json",
			JSON.stringify({
				id: "rst_2",
				status: "restoring",
				needsRecovery: false,
				finishedAt: null,
				updatedAt: new Date().toISOString(),
			}),
		),
	);
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { restore: 1 }, JSON.stringify(run));
	assert.equal(fired(), false, "it never got as far as confirming its claim");
	assert.equal(await has(env, "sto_c", KEY), true);
});

// ---------------------------------------------------------------------------------------------------------------
// Interleavings: the cleanup outside, another actor injected at each of its steps, with its lease live or lapsed.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The cleanup's steps, each a point an injected actor runs at: right after the claim (its first statement under
 * it), at the HEAD of the leftover's own copy, at the HEAD of the other copy, right before the statement that
 * re-confirms the claim, and at the object delete itself (after the confirm).
 */
const CLEANUP_STEPS = {
	claimed: (env, _fixture, during) =>
		onStatement(env, "SELECT 1 AS found FROM storage_cold_orphans WHERE id = ?", during),
	ownHead: (env, fixture, during) => onStore(env, fixture.leftoverStore, "head", KEY, during),
	otherHead: (env, fixture, during) => onStore(env, fixture.liveStore, "head", KEY, during),
	confirm: (env, _fixture, during) => onStatement(env, "claimed_until >= ? AND store_id = ?", during),
	delete: (env, fixture, during) => onStore(env, fixture.leftoverStore, "delete", KEY, during),
};

/**
 * Referenced mail with a leftover on sto_c: `row` has its live copy on sto_d named by a location row; `rowless` has
 * it on the default store with no row at all (what a storage migration leaves behind, B6).
 */
const FIXTURES = {
	row: async (env) => {
		addMessageRow(env, "m", KEY);
		await put(env, "sto_d", KEY, CONTENT);
		setLocation(env, KEY, "sto_d");
		await put(env, "sto_c", KEY, CONTENT);
		markLeftover(env, "sto_c", KEY);
		return { leftoverStore: "sto_c", liveStore: "sto_d" };
	},
	rowless: async (env) => {
		addMessageRow(env, "m", KEY);
		await put(env, "default", KEY, CONTENT);
		await put(env, "sto_c", KEY, CONTENT);
		markLeftover(env, "sto_c", KEY);
		return { leftoverStore: "sto_c", liveStore: "default" };
	},
};

/** What may run while the cleanup is mid-key: every other writer of a location row or deleter of a copy. */
const ACTORS = {
	// A stale sweep batch moving the key to a third store (a mover never targets the leftover's store here: that
	// store would be a cold target, and the cleanup keeps those).
	"mover to sto_e": (env) => move(env, "sto_e"),
	// A cold move onto the leftover's own store from a batch the cleanup cannot know about (no rule or job names it).
	"stale mover onto the leftover's store": (env) => move(env, "sto_c"),
	"migration purge of the leftover's store": (env, fixture) => purge(env, "sto_c", fixture.liveStore),
	// A storage migration that copied the object into the normal chain and drops the cold row it made stale.
	"migration dropping the row": async (env) => {
		await put(env, "default", KEY, CONTENT);
		return objectLocations.dropStaleLocationUnderLease(env, KEY, "sto_d");
	},
	"a second cleanup": (env) => cleanup(env),
};

for (const [fixtureName, prepare] of Object.entries(FIXTURES)) {
	for (const [stepName, hookAt] of Object.entries(CLEANUP_STEPS)) {
		for (const [actorName, actor] of Object.entries(ACTORS)) {
			for (const lapsed of [false, true]) {
				// A lapsed claim after the confirm is the one window no fence can close (a stall of more than five
				// minutes between the confirm and the object delete): docs/operations.md names it.
				if (lapsed && stepName === "delete") continue;
				test(`interleave (${fixtureName}): ${actorName} at the cleanup's ${stepName} step, lease ${lapsed ? "lapsed" : "live"}`, async (t) => {
					const { env } = await setup(t);
					const fixture = await prepare(env);
					let outcome = null;
					const fired = await hookAt(env, fixture, async () => {
						if (lapsed) lapse(env, KEY);
						outcome = await actor(env, fixture);
					});
					await cleanup(env);
					assert.equal(fired(), true, "the actor ran inside the cleanup");
					await assertReadable(env, KEY, CONTENT, `right after (${String(outcome)})`);
					// Whatever is left settles over later moves and cleanups without ever losing the object.
					await move(env, "sto_e");
					await assertReadable(env, KEY, CONTENT, "after a retried move");
					for (const days of [8, 16, 24]) {
						await cold.runStorageColdMaintenance(env, at(days));
						await cleanup(env, { days });
						await assertReadable(env, KEY, CONTENT, `after the cleanup at +${days} days`);
					}
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Interleavings: a mover or a migration purge outside, the cleanup injected at each of their steps.
// ---------------------------------------------------------------------------------------------------------------

/** The mover's steps: the target HEAD before its copy, its confirming HEAD after, its fenced record, its source delete. */
const MOVER_STEPS = {
	beforeCopy: (env, during) => onStore(env, "sto_c", "head", KEY, during),
	afterCopy: async (env, during) => {
		// The second HEAD on the target is the confirming one.
		const bucket = (await getStorage(env)).store("sto_c").bucket;
		const original = bucket.head.bind(bucket);
		let heads = 0;
		let fired = false;
		bucket.head = async (key, ...rest) => {
			if (key === KEY && ++heads === 2 && !fired) {
				fired = true;
				await during();
			}
			return original(key, ...rest);
		};
		return () => fired;
	},
	beforeRecord: (env, during) => {
		const batch = env.DB.batch.bind(env.DB);
		let fired = false;
		env.DB.batch = async (statements) => {
			if (!fired && statements.some((statement) => statement.sql?.includes("claimed_until"))) {
				fired = true;
				env.DB.batch = batch;
				await during();
			}
			return batch(statements);
		};
		return () => fired;
	},
	sourceDelete: (env, during) => onStore(env, "sto_d", "delete", KEY, during),
};

for (const [stepName, hookAt] of Object.entries(MOVER_STEPS)) {
	for (const leftoverBytes of ["same", "stale"]) {
		for (const lapsed of [false, true]) {
			test(`interleave: the cleanup at a mover's ${stepName} step (leftover ${leftoverBytes}, lease ${lapsed ? "lapsed" : "live"})`, async (t) => {
				const { env } = await setup(t);
				addMessageRow(env, "m", KEY);
				await put(env, "sto_d", KEY, CONTENT);
				setLocation(env, KEY, "sto_d");
				// A move back onto a store that still has an old leftover of the key (B2): the same bytes (the mover
				// reuses it without copying) or a stale one (the mover copies over it).
				await put(env, "sto_c", KEY, leftoverBytes === "same" ? CONTENT : "x");
				markLeftover(env, "sto_c", KEY);
				// The move comes from a batch the cleanup cannot see (no rule or job names sto_c), the worst case.
				const fired = await hookAt(env, async () => {
					if (lapsed) lapse(env, KEY);
					await cleanup(env);
				});
				const outcome = await move(env, "sto_c");
				assert.equal(fired(), true, `the cleanup ran inside the move (${outcome})`);
				await assertReadable(env, KEY, CONTENT, `right after (${outcome})`);
				await move(env, "sto_c");
				await assertReadable(env, KEY, CONTENT, "after a retried move");
				for (const days of [8, 16]) {
					await cold.runStorageColdMaintenance(env, at(days));
					await cleanup(env, { days });
					await assertReadable(env, KEY, CONTENT, `after the cleanup at +${days} days`);
				}
			});
		}
	}
}

/** The purge's steps: its HEAD of the new store, its HEAD of the old one, its delete of the old copy. */
for (const step of ["headTo", "headFrom", "deleteFrom"]) {
	for (const lapsed of [false, true]) {
		test(`interleave: the cleanup at a migration purge's ${step} step (lease ${lapsed ? "lapsed" : "live"}, B7)`, async (t) => {
			const { env } = await setup(t);
			// A storage migration moved mail from sto_c to the default store; the old copy on sto_c is both the purge's
			// to delete and a tracked leftover.
			addMessageRow(env, "m", KEY);
			await put(env, "default", KEY, CONTENT);
			await put(env, "sto_c", KEY, CONTENT);
			markLeftover(env, "sto_c", KEY);
			const [storeId, method] = {
				headTo: ["default", "head"],
				headFrom: ["sto_c", "head"],
				deleteFrom: ["sto_c", "delete"],
			}[step];
			const fired = await onStore(env, storeId, method, KEY, async () => {
				if (lapsed) lapse(env, KEY);
				await cleanup(env);
			});
			const outcome = await purge(env, "sto_c", "default");
			assert.equal(fired(), true, `the cleanup ran inside the purge (${outcome})`);
			await assertReadable(env, KEY, CONTENT, `right after (${outcome})`);
			assert.equal(await has(env, "default", KEY), true, "the copy the purge keeps is never touched");
		});
	}
}

test("a cleanup that stalls after its confirm keeps its copy, which a second cleanup relied on meanwhile (review of #479, M1/P2)", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	// Mail is routed to sto_c, so both copies are in the read chain; the key has no row and each copy is a
	// leftover: each cleanup sees the other copy as the readable one.
	routeTo(env, "mail", "sto_c");
	await put(env, "sto_c", KEY, CONTENT);
	await put(env, "default", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	markLeftover(env, "default", KEY);
	const realNow = Date.now;
	t.after(() => {
		Date.now = realNow;
	});
	let inner = null;
	// Right after the outer cleanup's confirm passed: the claim it extended runs out (a stall of more than 15
	// minutes), and a second cleanup settles the other leftover, relying on the outer one's copy.
	const fired = onStatementAfter(env, "claimed_until >= ? AND store_id = ?", async () => {
		lapse(env, KEY);
		Date.now = () => realNow() + 16 * 60 * 1000;
		inner = await cleanup(env, { storeId: "default" });
	});
	const outer = await cleanup(env, { storeId: "sto_c" });
	Date.now = realNow;
	assert.equal(fired(), true);
	assert.equal(inner.deleted, 1, `the second cleanup deleted the default copy: ${JSON.stringify(inner)}`);
	assert.deepEqual(outer.kept, { lease_lost: 1 }, "the stalled cleanup gave up instead of deleting");
	assert.equal(await has(env, "sto_c", KEY), true);
	await assertReadable(env, KEY, CONTENT, "after both cleanups");
});

/**
 * A delete on sto_c that the client gives up on (a timeout) without it having landed yet; `land()` applies it later,
 * as a slow store would after the abort.
 */
async function slowDeleteOnStoC(env) {
	const bucket = (await getStorage(env)).store("sto_c").bucket;
	const original = bucket.delete.bind(bucket);
	let pending = null;
	bucket.delete = async (key, options) => {
		bucket.delete = original;
		pending = key;
		assert.equal(options?.timeoutMs, 30_000, "the delete carries its deadline");
		throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
	};
	return {
		land: async () => {
			assert.ok(pending, "the delete was sent");
			await original(pending);
		},
	};
}

for (const variant of ["the same run", "a second cleanup"]) {
	test(`a delete that times out keeps the key claimed, so a late landing never takes the last copy (${variant}, review 2 of #479, B1)`, async (t) => {
		const { env } = await setup(t);
		addMessageRow(env, "m", KEY);
		routeTo(env, "mail", "sto_c");
		await put(env, "sto_c", KEY, CONTENT);
		await put(env, "default", KEY, CONTENT);
		// sto_c's leftover is settled first (the queue is ordered by when each was last looked at).
		markLeftover(env, "sto_c", KEY, { orphanedAt: NOW - 31 * DAY });
		markLeftover(env, "default", KEY);
		const slow = await slowDeleteOnStoC(env);
		if (variant === "the same run") {
			const run = await cleanup(env);
			assert.deepEqual(run.kept, { error: 1, busy: 1 }, JSON.stringify(run));
		} else {
			assert.deepEqual((await cleanup(env, { storeId: "sto_c" })).kept, { error: 1 });
			assert.deepEqual((await cleanup(env, { storeId: "default" })).kept, { busy: 1 }, "the key is still claimed");
		}
		const claim = location(env, KEY);
		assert.equal(claim.store_id, "default", "the held claim names the copy that stays");
		assert.ok(claim.claimed_until >= NOW + 14 * 60, "held to the confirm's 15-minute expiry");
		await slow.land();
		assert.equal(await has(env, "sto_c", KEY), false);
		await assertReadable(env, KEY, CONTENT, "after the late delete landed");

		// Once the claim has run out, the next cleanup finds the default copy is the only one and keeps it.
		lapse(env, KEY);
		const later = await cleanup(env, { days: 1 });
		assert.equal(later.deleted, 0, JSON.stringify(later));
		assert.equal(await has(env, "default", KEY), true);
		await assertReadable(env, KEY, CONTENT, "after the next cleanup");
	});
}

test("the final check holds the key for 15 minutes, well past the 30-second limit for issuing and finishing the delete", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "sto_d", KEY, CONTENT);
	setLocation(env, KEY, "sto_d");
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	let claimedUntil = null;
	const fired = onStatementAfter(env, "claimed_until >= ? AND store_id = ?", async () => {
		claimedUntil = location(env, KEY).claimed_until;
	});
	const run = await cleanup(env);
	assert.equal(fired(), true);
	assert.equal(run.deleted, 1);
	const now = Math.floor(Date.now() / 1000);
	assert.ok(
		claimedUntil >= now + 14 * 60 && claimedUntil <= now + 15 * 60 + 5,
		`claimed_until ${claimedUntil - now}s ahead`,
	);
});

// Round 9's two probes, both of which lost every copy then (B6): the cleanup outside, a mover inside it.
for (const lapsed of [false, true]) {
	test(`B6 probe A: a sweep mover inside the cleanup of a row-less key whose leftover is gone keeps a copy (lease ${lapsed ? "lapsed" : "live"})`, async (t) => {
		const { env } = await setup(t);
		addMessageRow(env, "m", KEY);
		await put(env, "default", KEY, CONTENT);
		markLeftover(env, "sto_c", KEY); // its object is already gone
		const fired = await onStore(env, "sto_c", "head", KEY, async () => {
			if (lapsed) lapse(env, KEY);
			await move(env, "sto_c");
		});
		await cleanup(env);
		assert.equal(fired(), true);
		await assertReadable(env, KEY, CONTENT, "after the race");
		for (const days of [8, 16]) {
			await cold.runStorageColdMaintenance(env, at(days));
			await cleanup(env, { days });
			await assertReadable(env, KEY, CONTENT, `after the cleanup at +${days} days`);
		}
	});

	test(`B6 probe B: the shortcut mover inside a cleanup, then cleanups of the hot store, never lose the object (lease ${lapsed ? "lapsed" : "live"})`, async (t) => {
		const { env } = await setup(t);
		addMessageRow(env, "m", KEY);
		await put(env, "sto_d", KEY, CONTENT);
		await put(env, "sto_c", KEY, CONTENT);
		// Mail is routed to sto_d (the hot chain) and sto_c has an identical leftover with no row: what a storage
		// migration leaves behind. The nightly mover then finds sto_c first and takes the shortcut.
		const switched = await lib.routeSwitch.switchRoute(env, { id: "owner" }, "mail", { storeId: "sto_d" }, APP_ORIGIN);
		assert.equal(switched.ok, true, switched.error);
		markLeftover(env, "sto_c", KEY);
		const fired = await onStore(env, "sto_c", lapsed ? "head" : "delete", KEY, async () => {
			if (lapsed) lapse(env, KEY);
			await move(env, "sto_c");
		});
		await cleanup(env);
		assert.equal(fired(), true);
		await assertReadable(env, KEY, CONTENT, "after the first cleanup");
		// The shortcut may have marked the hot copy a leftover; cleaning that store up later must still keep one.
		env.DB.db.prepare("UPDATE storage_cold_orphans SET first_orphaned_at = ?").run(NOW - 30 * DAY);
		for (const storeId of ["sto_d", "sto_c", null]) {
			await cleanup(env, { storeId });
			await assertReadable(env, KEY, CONTENT, `after cleaning ${storeId ?? "every store"}`);
		}
	});
}

test("a cleanup that dies after creating its claim row leaves nothing that lies about where the bytes are (B5)", async (t) => {
	const { env } = await setup(t);
	addMessageRow(env, "m", KEY);
	await put(env, "default", KEY, CONTENT);
	await put(env, "sto_c", KEY, CONTENT);
	markLeftover(env, "sto_c", KEY);
	// A throw at the leftover's HEAD, after the claim row exists: the run records an error and removes its row.
	await onStore(env, "sto_c", "head", KEY, () => {
		throw new Error("connection reset");
	});
	const run = await cleanup(env);
	assert.deepEqual(run.kept, { error: 1 });
	assert.equal(location(env, KEY), undefined, "the claim row was removed");
	assert.equal(await has(env, "sto_c", KEY), true);

	// A crash with no `finally` at all strands the row; it names the store with the bytes, never counts as a cold
	// location and is dropped once its claim expires.
	const claim = await objectLocations.claimKeyForLeftover(env, KEY, "mail", async () => ({
		storeId: "default",
		size: 1,
	}));
	assert.equal(claim.created, true);
	assert.equal(location(env, KEY).store_id, "default");
	assert.equal(await objectLocations.storeHoldsLocatedObjects(env, "default"), false);
	assert.match(await move(env, "sto_e"), /lease/i, "a mover backs off while the claim is live");
	lapse(env, KEY);
	assert.equal(await move(env, "sto_e"), "moved", "and takes the key over once it expired");
	await assertReadable(env, KEY, CONTENT, "after the takeover");
	assert.equal(location(env, KEY).store_id, "sto_e");
});

// ---------------------------------------------------------------------------------------------------------------
// The automatic cleanup, the settings and the admin API.
// ---------------------------------------------------------------------------------------------------------------

async function unreferencedLeftover(env) {
	await put(env, "sto_c", KEY, CONTENT);
	setLocation(env, KEY, "sto_c");
	markLeftover(env, "sto_c", KEY, { unreferencedSince: NOW - 20 * DAY });
}

test("the automatic cleanup is off by default; turned on, the five-minute maintenance deletes a few at a time", async (t) => {
	const { env } = await setup(t);
	await unreferencedLeftover(env);
	await cold.runStorageColdMaintenance(env, at(0));
	assert.equal(await has(env, "sto_c", KEY), true, "off by default");

	const saved = await leftoverState.saveLeftoverSettings(env, "owner", { automatic: true, graceDays: 7 });
	assert.equal(saved.ok, true);
	await cold.runStorageColdMaintenance(env, at(0));
	assert.equal(await has(env, "sto_c", KEY), false);
	const audit = env.DB.db.prepare("SELECT * FROM audit_logs WHERE action = 'storage.leftovers_deleted'").get();
	assert.equal(audit.actor_user_id, null);
	assert.equal(JSON.parse(audit.metadata).trigger, "automatic");
	const state = await leftoverState.readLeftoverState(env);
	assert.equal(state.lastRun.trigger, "automatic");
	assert.equal(state.lastRun.deleted, 1);
});

test("the grace period setting applies to both cleanups and is validated", async (t) => {
	const { env } = await setup(t);
	await unreferencedLeftover(env);
	for (const bad of [{ automatic: true, graceDays: 0 }, { automatic: "yes", graceDays: 7 }, { graceDays: 400 }, null]) {
		const result = await leftoverState.saveLeftoverSettings(env, "owner", bad);
		assert.equal(result.ok, false, JSON.stringify(bad));
		assert.equal(result.status, 400);
	}
	await leftoverState.saveLeftoverSettings(env, "owner", { automatic: false, graceDays: 40 });
	let run = await cleanup(env);
	assert.equal(run.checked, 0, "marked 30 days ago is not past a 40-day grace period");
	await leftoverState.saveLeftoverSettings(env, "owner", { automatic: false, graceDays: 30 });
	run = await cleanup(env);
	assert.deepEqual(run.kept, { confirming: 1 }, "past it, but unreferenced for only 20 of the 30 days");
	run = await cleanup(env, { days: 11 });
	assert.equal(run.deleted, 1);
});

async function caller(env, userId) {
	const token = await lib.session.createSession(env, userId);
	return async (method, body) => {
		const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: APP_ORIGIN };
		const request = new Request(`${APP_ORIGIN}/api/admin/storage/leftovers`, {
			method,
			headers,
			body: JSON.stringify(body ?? {}),
		});
		const response = await lib.leftoversRoute[method](request);
		return { status: response.status, body: await response.json() };
	};
}

test("Delete leftovers is for the primary admin only, checks the origin and writes an audit row", async (t) => {
	const { env } = await setup(t);
	await unreferencedLeftover(env);
	assert.equal((await (await caller(env, "second"))("POST", {})).status, 403, "another admin is refused");
	// Session-cookie requests from another origin are refused by the shared mutation check every method runs.
	const { readFileSync } = await import("node:fs");
	const routeSource = readFileSync(new URL("../src/app/api/admin/storage/leftovers/route.ts", import.meta.url), "utf8");
	assert.equal(
		routeSource.match(/authorizeStorage\(request, true\)/g)?.length,
		2,
		"POST and PUT both check the origin",
	);
	assert.equal(await has(env, "sto_c", KEY), true);
	assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM audit_logs").get().n, 0);

	const owner = await caller(env, "owner");
	const unknown = await owner("POST", { storeId: "sto_nope" });
	assert.equal(unknown.status, 404);
	const done = await owner("POST", { storeId: "sto_c" });
	assert.equal(done.status, 200, JSON.stringify(done.body));
	assert.equal(done.body.deleted, 1);
	assert.equal(done.body.remaining, 0);
	assert.equal(await has(env, "sto_c", KEY), false);
	const audit = env.DB.db.prepare("SELECT * FROM audit_logs WHERE action = 'storage.leftovers_deleted'").get();
	assert.equal(audit.actor_user_id, "owner");
	assert.deepEqual(JSON.parse(audit.metadata), {
		trigger: "manual",
		storeId: "sto_c",
		deleted: 1,
		cleared: 0,
		kept: {},
		skipped: null,
	});

	const settings = await owner("PUT", { automatic: true, graceDays: 14 });
	assert.equal(settings.status, 200);
	assert.deepEqual(settings.body.settings, { automatic: true, graceDays: 14 });
	assert.ok(env.DB.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'storage.leftover_cleanup_updated'").get());
	const overview = await stores.storageOverview(env);
	assert.deepEqual(overview.leftovers.settings, { automatic: true, graceDays: 14 });
	assert.equal(overview.leftovers.lastRun.trigger, "manual");
});

test("a store whose only blocker is leftovers is offered the cleanup, and can be deleted afterwards", async (t) => {
	const { env } = await setup(t);
	await unreferencedLeftover(env);
	env.DB.db.prepare("DELETE FROM object_locations").run();
	const refused = await stores.deleteStore(env, { id: "owner" }, "sto_c");
	assert.equal(refused.status, 409);
	assert.equal(refused.code, "LEFTOVERS_ONLY");
	assert.equal(refused.leftoverCount, 1);
	const run = await cleanup(env, { storeId: "sto_c" });
	assert.equal(run.deleted, 1, JSON.stringify(run));
	assert.equal((await stores.deleteStore(env, { id: "owner" }, "sto_c")).ok, true);
});

test("before migration 0108 the cleanup does nothing and says so, and marking still works", async (t) => {
	const { env } = await setup(t);
	await unreferencedLeftover(env);
	env.DB.db.exec("ALTER TABLE storage_state DROP COLUMN leftover_cleanup");
	env.DB.db.exec("ALTER TABLE storage_cold_orphans DROP COLUMN kept_reason");
	env.DB.db.exec("ALTER TABLE storage_cold_orphans DROP COLUMN unreferenced_since");
	const run = await cleanup(env);
	assert.equal(run.skipped, "unsupported");
	const manual = await coldLeftovers.deleteLeftovers(env, "owner", {});
	assert.equal(manual.status, 409);
	assert.equal(manual.code, "MIGRATION_PENDING");
	assert.equal((await leftoverState.saveLeftoverSettings(env, "owner", { automatic: true, graceDays: 7 })).status, 409);
	await cold.runStorageColdMaintenance(env, at(0));
	await objectLocations.markOrphanCandidate(env, {
		storeId: "sto_d",
		key: KEY,
		objectClass: "mail",
		movedAt: new Date(),
	});
	assert.ok(leftover(env, KEY, "sto_d"), "the 0104 shape still records a candidate");
	assert.equal(await has(env, "sto_c", KEY), true);
	const overview = await leftoverState.leftoverOverview(env);
	assert.equal(overview.available, false);
	assert.equal(overview.total, 2);
});
