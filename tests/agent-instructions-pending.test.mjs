import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-instructions-pending-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		mailbox: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/mailbox-settings.ts")),
		personal: fileURLToPath(import.meta.resolve("../src/lib/agent/user-ai-settings.ts")),
		lookup: fileURLToPath(import.meta.resolve("../src/lib/auth/user-lookup-utils.ts")),
		migration: fileURLToPath(import.meta.resolve("../src/lib/agent/ai-writing-migration.ts")),
		install: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/install-settings.ts")),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const mailbox = await load("mailbox");
const personal = await load("personal");
const { missingColumnFromError } = await load("lookup");
const { aiWritingMigrationApplied } = await load("migration");
const install = await load("install");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

/** A migrated database; `behind` undoes migration 0069, as on an install that deployed before applying it. */
async function database(t, { behind = false } = {}) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'user-1', 'domain-1', 'a', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, instructions, updated_at) VALUES ('mailbox-a', 1, 'Be brief.', 1);
	`);
	if (behind)
		sqlite.db.exec(`
			ALTER TABLE mailbox_agent_settings DROP COLUMN chat_instructions;
			ALTER TABLE mailbox_agent_settings DROP COLUMN draft_instructions;
			ALTER TABLE mailbox_agent_settings DROP COLUMN summary_instructions;
			DROP TABLE user_ai_settings;
			ALTER TABLE app_settings DROP COLUMN agent_auto_read_token_cap;
			ALTER TABLE app_settings DROP COLUMN agent_chat_token_cap;
		`);
	return { sqlite, db: createDb(sqlite), env: { DB: sqlite } };
}

test("a pending column is recognised in every way the database reports it, and nothing else is", () => {
	assert.equal(missingColumnFromError(new Error("no such column: chat_instructions")), "chat_instructions");
	assert.equal(
		missingColumnFromError('no such column: "mailbox_agent_settings"."draft_instructions"'),
		"draft_instructions",
	);
	const wrapped = new Error("Failed query", { cause: new Error("table x has no column named summary_instructions") });
	assert.equal(missingColumnFromError(wrapped), "summary_instructions");
	assert.equal(missingColumnFromError(new Error("no such table: user_ai_settings")), null);
	assert.equal(missingColumnFromError(null), null);
	assert.equal(missingColumnFromError(42), null);
});

const access = {
	mailbox: { id: "mailbox-a", userId: "user-1", type: "personal" },
};

test("before migration 0069 the settings read with empty task fields and save without them", async (t) => {
	const { sqlite, db, env } = await database(t, { behind: true });
	assert.equal(await aiWritingMigrationApplied(env), false);
	const settings = await mailbox.readMailboxAgentSettings(db, access);
	assert.equal(settings.instructions, "Be brief.");
	assert.deepEqual([settings.chatInstructions, settings.draftInstructions, settings.summaryInstructions], ["", "", ""]);
	const row = await mailbox.readMailboxAgentSettingsRow(db, "mailbox-a");
	assert.equal(row.chatInstructions, "");

	const values = {
		...settings,
		enabled: true,
		instructions: "Be kind.",
		capabilities: JSON.stringify(settings.capabilities),
	};
	assert.equal(await mailbox.saveMailboxAgentSettings(db, values), "saved");
	assert.equal(sqlite.db.prepare("SELECT instructions FROM mailbox_agent_settings").get().instructions, "Be kind.");
	assert.equal(
		await mailbox.saveMailboxAgentSettings(db, { ...values, instructions: "Lost?", draftInstructions: "Use we." }),
		"migration_pending",
	);
	assert.equal(sqlite.db.prepare("SELECT instructions FROM mailbox_agent_settings").get().instructions, "Be kind.");

	sqlite.db.exec("DELETE FROM mailbox_agent_settings");
	await mailbox.ensureMailboxAgentSettingsRow(db, access);
	await mailbox.ensureMailboxAgentSettingsRow(db, access);
	assert.equal(sqlite.db.prepare("SELECT count(*) AS n FROM mailbox_agent_settings").get().n, 1);
	assert.equal(await mailbox.saveMailboxAgentSettings(db, { ...values, mailboxId: "mailbox-a" }), "saved");
});

test("before migration 0069 personal instructions read as empty and cannot be saved", async (t) => {
	const { db } = await database(t, { behind: true });
	const state = await personal.readUserAiSettings(db, "user-1");
	assert.equal(state.ready, false);
	assert.deepEqual(state.instructions, { general: "", chat: "", draft: "", summary: "" });
	assert.equal(await personal.personalInstructionsFor(db, { id: "user-1", name: "Owner" }), null);
	await assert.rejects(
		personal.savePersonalInstructions(db, "user-1", { general: "a", chat: "", draft: "", summary: "" }),
		personal.UserAiSettingsPendingError,
	);
});

test("after migration 0069 the task fields and personal instructions save and read back", async (t) => {
	const { db, env } = await database(t);
	assert.equal(await aiWritingMigrationApplied(env), true);
	const settings = await mailbox.readMailboxAgentSettings(db, access);
	const values = {
		...settings,
		enabled: true,
		chatInstructions: "Be formal.",
		draftInstructions: "Use we.",
		summaryInstructions: "One line.",
		capabilities: JSON.stringify(settings.capabilities),
	};
	assert.equal(await mailbox.saveMailboxAgentSettings(db, values), "saved");
	const saved = await mailbox.readMailboxAgentSettings(db, access);
	assert.deepEqual(
		[saved.chatInstructions, saved.draftInstructions, saved.summaryInstructions],
		["Be formal.", "Use we.", "One line."],
	);

	assert.equal(await personal.personalInstructionsFor(db, { id: "user-1", name: "Owner" }), null);
	const fields = { general: "I am the CFO.", chat: "", draft: "Sign as O.", summary: "" };
	await personal.savePersonalInstructions(db, "user-1", fields);
	await personal.savePersonalInstructions(db, "user-1", { ...fields, chat: "Bullets." });
	const state = await personal.readUserAiSettings(db, "user-1");
	assert.equal(state.ready, true);
	assert.equal(state.writingStyleEnabled, false);
	assert.deepEqual(state.instructions, { ...fields, chat: "Bullets." });
	assert.deepEqual(await personal.personalInstructionsFor(db, { id: "user-1", name: "Owner" }), {
		...fields,
		chat: "Bullets.",
		name: "Owner",
	});
});

test("before migration 0069 the token allowances read as their defaults and only they refuse to save", async (t) => {
	const { sqlite, env } = await database(t, { behind: true });
	sqlite.db.exec("UPDATE app_settings SET agent_daily_spend_cap_micros = 3000000 WHERE id = 'default'");
	const before = await install.getAutoReadInstallSettings(env);
	assert.deepEqual(
		[before.dailySpendCapMicros, before.autoReadTokenCap, before.chatTokenCap],
		[3_000_000, 2_000_000, 2_000_000],
	);
	assert.equal((await install.getAutoReadAdminSettings(env)).tokenCapsReady, false);
	await install.saveAutoReadAdminSettings(env, { dailySpendCapMicros: 4_000_000 });
	assert.equal((await install.getAutoReadInstallSettings(env)).dailySpendCapMicros, 4_000_000);
	await assert.rejects(install.saveAutoReadAdminSettings(env, { chatTokenCap: 50_000 }), install.TokenCapsPendingError);
});

test("after migration 0069 both token allowances save, on a fresh install too", async (t) => {
	const { env } = await database(t);
	assert.equal((await install.getAutoReadInstallSettings(env)).chatTokenCap, 2_000_000);
	await install.saveAutoReadAdminSettings(env, { autoReadTokenCap: 300_000, chatTokenCap: 50_000 });
	const saved = await install.getAutoReadAdminSettings(env);
	assert.deepEqual([saved.autoReadTokenCap, saved.chatTokenCap, saved.tokenCapsReady], [300_000, 50_000, true]);
	assert.equal(saved.dailySpendCapMicros, 2_000_000);
});

test("whole-row reads name every column with its table, so D1 cannot read a missing one as its own name", async (t) => {
	const { sqlite } = await database(t, { behind: true });
	const statements = [];
	const recording = new Proxy(sqlite, {
		get(target, key) {
			if (key === "prepare")
				return (query) => {
					statements.push(query);
					return target.prepare(query);
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const row = await mailbox.readMailboxAgentSettingsRow(createDb(recording), "mailbox-a");
	assert.equal(row.chatInstructions, "");
	const first = statements.find((query) => query.includes("chat_instructions"));
	assert.match(first, /"mailbox_agent_settings"\."chat_instructions"/);
	assert.doesNotMatch(first, /select "mailbox_id"/i);
});
