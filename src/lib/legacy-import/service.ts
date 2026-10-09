import { BACKUP_TABLES, listApplicationTables, readTablePage } from "@/lib/backups/export";
import { chunkRestoreStatements, planRestoreStatements, planTableInserts } from "@/lib/backups/restore-utils";
import type { RestoreTablePlan } from "@/lib/backups/restore-types";
import { createSafetyBackup } from "@/lib/backups/safety";
import { newId } from "@/lib/ids";
import { getMigrationStatus } from "@/lib/migrations/service";
import { isSealed, openSecret } from "@/lib/security/secret-box";
import {
	addProblem,
	createLegacyImportState,
	isCopyableObjectKey,
	isLegacyImportState,
	LEGACY_IMPORT_STATE_KEY,
	recordTablePage,
	SEALED_SETTING_LABELS,
	selectCopyTables,
	toLegacyImportRun,
} from "./copy-utils";
import type {
	LegacyImportMode,
	LegacyImportRun,
	LegacyImportSource,
	LegacyImportState,
	LegacyImportStatus,
} from "./types";

/**
 * Copies an install's data from the database and bucket it used before (the
 * LEGACY_DB and LEGACY_BUCKET bindings) into this one, a bounded step per
 * request so no single request runs into Worker limits. Every insert is
 * INSERT OR IGNORE and every file is skipped when already present, so a step
 * can be repeated after a failure and a "catch-up" run only adds what is new.
 */

const PAGE_ROWS = 100;
const STEP_ROW_BUDGET = 500;
const STEP_FILE_LIMIT = 25;

export class LegacyImportError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

type LegacyBindings = { db: D1Database; bucket: R2Bucket };

function getLegacyBindings(env: CloudflareEnv): LegacyBindings | null {
	return env.LEGACY_DB && env.LEGACY_BUCKET ? { db: env.LEGACY_DB, bucket: env.LEGACY_BUCKET } : null;
}

function requireLegacyBindings(env: CloudflareEnv): LegacyBindings {
	const legacy = getLegacyBindings(env);
	if (!legacy) throw new LegacyImportError("This install has no old database to copy from.", 404);
	return legacy;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readState(env: CloudflareEnv): Promise<LegacyImportState | null> {
	const object = await env.BUCKET.get(LEGACY_IMPORT_STATE_KEY);
	if (!object) return null;
	try {
		const value: unknown = JSON.parse(await object.text());
		return isLegacyImportState(value) ? value : null;
	} catch {
		return null;
	}
}

async function writeState(env: CloudflareEnv, state: LegacyImportState): Promise<void> {
	await env.BUCKET.put(LEGACY_IMPORT_STATE_KEY, JSON.stringify(state), {
		httpMetadata: { contentType: "application/json" },
	});
}

async function describeSource(db: D1Database): Promise<LegacyImportSource> {
	try {
		const tables = await listApplicationTables(db);
		const messages = tables.has("messages")
			? ((await db.prepare("SELECT COUNT(*) AS total FROM messages").first<{ total: number }>())?.total ?? 0)
			: null;
		return { tables: tables.size, messages };
	} catch (error) {
		return { tables: 0, messages: null, error: describe(error) };
	}
}

export async function getLegacyImportStatus(env: CloudflareEnv): Promise<LegacyImportStatus> {
	const legacy = getLegacyBindings(env);
	if (!legacy) return { available: false, source: null, run: null };
	const state = await readState(env);
	const source = await describeSource(legacy.db);
	// Local development binds an empty stand-in for the old database; there is nothing to offer.
	if (!state && !source.error && source.tables === 0) return { available: false, source: null, run: null };
	return { available: true, source, run: state ? toLegacyImportRun(state) : null };
}

export async function startLegacyImport(
	env: CloudflareEnv,
	mode: LegacyImportMode,
	userId: string | null,
): Promise<{ token: string; run: LegacyImportRun }> {
	const legacy = requireLegacyBindings(env);
	const status = await getMigrationStatus(env.DB);
	if (status.pending.length || status.unknown.length)
		throw new LegacyImportError("Update the database in the Database card before copying.", 409);
	const sourceTables = await listApplicationTables(legacy.db);
	if (!sourceTables.has("users") || !sourceTables.has("messages"))
		throw new LegacyImportError("The old database has no Kite data to copy.", 409);
	const tables = selectCopyTables(BACKUP_TABLES, sourceTables, await listApplicationTables(env.DB));
	const safety = mode === "full" ? await createSafetyBackup(env, "pre-restore", userId) : null;
	const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const state = createLegacyImportState({
		id: newId("imp"),
		mode,
		tokenHash: await sha256(token),
		tables,
		safetyBackupKey: safety?.r2Key ?? null,
		now: new Date(),
	});
	await writeState(env, state);
	return { token, run: toLegacyImportRun(state) };
}

/**
 * Runs the step `step` of the current copy. A repeated or out-of-date step
 * number does no work and returns the current state, so a page that retries
 * after a lost response simply carries on from where the copy is.
 */
export async function runLegacyImportStep(env: CloudflareEnv, token: string, step: number): Promise<LegacyImportRun> {
	const legacy = requireLegacyBindings(env);
	const state = await readState(env);
	if (!state || state.tokenHash !== (await sha256(token)))
		throw new LegacyImportError("This copy was started from another page. Start it again here.", 403);
	if (state.phase === "done" || state.step !== step) return toLegacyImportRun(state);

	if (state.phase === "clear") await clearTables(env.DB, state);
	else if (state.phase === "tables") await copyTables(env.DB, legacy.db, state);
	else if (state.phase === "files") await copyFiles(env.BUCKET, legacy.bucket, state);
	if (hasFinished(state)) {
		state.unreadableSecrets = await findUnreadableSecrets(env);
		state.finishedAt = new Date().toISOString();
	}
	state.step += 1;
	state.updatedAt = new Date().toISOString();
	await writeState(env, state);
	return toLegacyImportRun(state);
}

// A function, not an inline check, because TypeScript keeps the narrowing from the early return above.
function hasFinished(state: LegacyImportState): boolean {
	return state.phase === "done";
}

/** Empties every backed-up table, children first, before a full copy. */
async function clearTables(db: D1Database, state: LegacyImportState): Promise<void> {
	const present = await listApplicationTables(db);
	const { deletes } = planRestoreStatements(
		BACKUP_TABLES.filter((table) => present.has(table)).map((name) => ({ name, rows: [], columns: null })),
	);
	await db.batch(deletes.map((statement) => db.prepare(statement.sql)));
	state.phase = "tables";
}

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
	const { results } = await db.prepare(`PRAGMA table_info(\`${table.replaceAll("`", "``")}\`)`).all<{ name: string }>();
	return new Set(results.map((column) => column.name));
}

async function copyTables(target: D1Database, source: D1Database, state: LegacyImportState): Promise<void> {
	const columns = new Map<string, Set<string>>();
	let budget = STEP_ROW_BUDGET;
	while (budget > 0 && state.phase === "tables") {
		const name = state.tables[state.tableIndex];
		if (!columns.has(name)) columns.set(name, await tableColumns(target, name));
		const page = await readTablePage(source, name, state.lastRowid, PAGE_ROWS);
		const written = page.rows.length
			? await insertRows(target, { name, rows: page.rows, columns: columns.get(name)! }, state)
			: 0;
		recordTablePage(state, {
			read: page.rows.length,
			written,
			skipped: page.rows.length - written,
			lastRowid: page.lastRowid,
			complete: page.rows.length < PAGE_ROWS,
		});
		budget -= Math.max(page.rows.length, 1);
	}
}

/** Inserts a page as a batch; if the batch fails, row by row, so one bad row costs only itself. */
async function insertRows(db: D1Database, table: RestoreTablePlan, state: LegacyImportState): Promise<number> {
	try {
		let written = 0;
		for (const chunk of chunkRestoreStatements(planTableInserts(table, { ignoreConflicts: true }))) {
			const results = await db.batch(chunk.map((statement) => db.prepare(statement.sql).bind(...statement.params)));
			for (const result of results) written += result.meta?.changes ?? 0;
		}
		return written;
	} catch {
		let written = 0;
		for (const statement of planTableInserts(table, { ignoreConflicts: true, maxRowsPerStatement: 1 })) {
			try {
				const result = await db
					.prepare(statement.sql)
					.bind(...statement.params)
					.run();
				written += result.meta?.changes ?? 0;
			} catch (error) {
				addProblem(state, `${table.name.replaceAll("_", " ")}: ${describe(error)}`);
			}
		}
		return written;
	}
}

async function copyObject(target: R2Bucket, key: string, object: R2ObjectBody): Promise<void> {
	const options = { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata };
	if (typeof FixedLengthStream !== "function") {
		await target.put(key, object.body, options);
		return;
	}
	// R2 only accepts a stream whose length is known up front.
	const { readable, writable } = new FixedLengthStream(object.size);
	await Promise.all([target.put(key, readable, options), object.body.pipeTo(writable)]);
}

async function copyFiles(target: R2Bucket, source: R2Bucket, state: LegacyImportState): Promise<void> {
	const listing = await source.list({
		limit: STEP_FILE_LIMIT,
		...(state.fileCursor ? { cursor: state.fileCursor } : {}),
	});
	for (const item of listing.objects) {
		if (!isCopyableObjectKey(item.key)) continue;
		const existing = await target.head(item.key);
		if (existing && existing.size === item.size) {
			state.files.skipped += 1;
			continue;
		}
		const object = await source.get(item.key);
		if (!object) {
			state.files.skipped += 1;
			continue;
		}
		await copyObject(target, item.key, object);
		state.files.copied += 1;
		state.files.bytes += item.size;
	}
	if (listing.truncated) {
		state.fileCursor = listing.cursor;
	} else {
		state.fileCursor = null;
		state.phase = "done";
	}
}

async function canOpen(env: CloudflareEnv, value: unknown): Promise<boolean> {
	if (typeof value !== "string" || !isSealed(value)) return true;
	try {
		await openSecret(env.APP_ENCRYPTION_KEY, value);
		return true;
	} catch {
		return false;
	}
}

/** Settings sealed with the old install's APP_ENCRYPTION_KEY that this one cannot read, to re-enter. */
async function findUnreadableSecrets(env: CloudflareEnv): Promise<string[]> {
	const found = new Set<string>();
	try {
		const settings = await env.DB.prepare("SELECT * FROM app_settings").all<Record<string, unknown>>();
		for (const row of settings.results) {
			for (const [column, label] of Object.entries(SEALED_SETTING_LABELS)) {
				if (!(await canOpen(env, row[column]))) found.add(label);
			}
		}
		const hooks = await env.DB.prepare("SELECT secret FROM webhooks").all<{ secret: string }>();
		let unreadable = 0;
		for (const hook of hooks.results) if (!(await canOpen(env, hook.secret))) unreadable += 1;
		if (unreadable) found.add(`Signing secret of ${unreadable} webhook${unreadable === 1 ? "" : "s"}`);
	} catch {
		// A schema without these tables has nothing sealed to report.
	}
	return [...found];
}
