import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, applyMigrations, loadOnboardingChecklistState, getAgentEnabled } = await bundleModules(
	"kite-onboarding-checklist-",
	[
		["SqliteDatabase", "server/runtime/sqlite-database.ts"],
		["applyMigrations", "server/runtime/migrate.ts"],
		["loadOnboardingChecklistState", "src/lib/admin/onboarding-checklist.ts"],
		["getAgentEnabled", "src/lib/agent/provider.ts"],
	],
);

const scratch = makeBundleDirectory("kite-onboarding-checklist-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

const OWNER = { id: "owner", canManageMailboxes: false, createdByUserId: null };
/** No restore job, so `getBackupHealth` never reads a real R2 object. */
const EMPTY_BUCKET = { get: async () => null };

async function database(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, "drizzle/migrations");
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
	`);
	return sqlite;
}

test("a schema behind migration 0062 reads modules as not configured instead of failing the whole checklist", async (t) => {
	const sqlite = await database(t);
	sqlite.db.exec("DROP TABLE module_settings");
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	const state = await loadOnboardingChecklistState(env, OWNER);
	assert.equal(state.modulesConfigured, false);
	// Every other item still reads real state: this one field going missing never 500s the rest.
	assert.equal(state.domainActive, true);
	assert.equal(state.mailboxCount, 1);
});

test("a schema behind migration 0034 reads the assistant as on by default instead of failing", async (t) => {
	const sqlite = await database(t);
	sqlite.db.exec("ALTER TABLE app_settings DROP COLUMN agent_enabled");
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	assert.equal(await getAgentEnabled(env), true);
	const state = await loadOnboardingChecklistState(env, OWNER);
	// On by default and nothing saved yet: the step still shows as not done.
	assert.equal(state.assistantConfigured, false);
});

test("a schema behind both migrations still answers the whole checklist in one call", async (t) => {
	const sqlite = await database(t);
	sqlite.db.exec("DROP TABLE module_settings");
	sqlite.db.exec("ALTER TABLE app_settings DROP COLUMN agent_enabled");
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	const state = await loadOnboardingChecklistState(env, OWNER);
	assert.equal(state.modulesConfigured, false);
	assert.equal(state.assistantConfigured, false);
	assert.equal(state.domainActive, true);
});

test("modules only read as configured once an owner actually changed one, not from migration 0062's own seed rows", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	// Migration 0062 seeds Calendar, Booking, Email templates and Mail import as on, with no owner behind it.
	const seeded = sqlite.db
		.prepare("SELECT module_id, enabled, updated_by FROM module_settings ORDER BY module_id")
		.all();
	assert.deepEqual(
		seeded.map((row) => row.module_id),
		["booking", "calendar", "import", "templates"],
	);
	assert.ok(seeded.every((row) => row.updated_by === null));
	assert.equal((await loadOnboardingChecklistState(env, OWNER)).modulesConfigured, false);

	sqlite.db.exec("UPDATE module_settings SET updated_by = 'owner' WHERE module_id = 'templates'");
	assert.equal((await loadOnboardingChecklistState(env, OWNER)).modulesConfigured, true);
});

test("the assistant only reads as configured once a provider was actually chosen, not from the seeded settings row", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	// Every fresh install already has one `app_settings` row (migration 0012); nothing chosen yet still reads false.
	assert.equal((await loadOnboardingChecklistState(env, OWNER)).assistantConfigured, false);

	sqlite.db.exec(
		"UPDATE app_settings SET agent_provider = 'compatible', agent_preset = 'openai', agent_api_key = 'sk-test', agent_model = 'gpt-4o-mini' WHERE id = 'default'",
	);
	assert.equal((await loadOnboardingChecklistState(env, OWNER)).assistantConfigured, true);

	sqlite.db.exec(
		"UPDATE app_settings SET agent_provider = NULL, agent_preset = NULL, agent_api_key = NULL, agent_model = NULL, agent_enabled = 0 WHERE id = 'default'",
	);
	assert.equal(
		(await loadOnboardingChecklistState(env, OWNER)).assistantConfigured,
		true,
		"deliberately off needs nothing",
	);
});

test("a saved provider whose key a rotated encryption key can no longer open does not read as configured", async (t) => {
	const sqlite = await database(t);
	// The "enc:v1:" prefix marks it sealed; with no APP_ENCRYPTION_KEY in this env, opening it always fails.
	sqlite.db.exec(
		"UPDATE app_settings SET agent_provider = 'compatible', agent_preset = 'openai', agent_api_key = 'enc:v1:AAAA:BBBB', agent_model = 'gpt-4o-mini' WHERE id = 'default'",
	);
	const env = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	assert.equal((await loadOnboardingChecklistState(env, OWNER)).assistantConfigured, false);
});

test("a Workers AI binding or an AI_BASE_URL/AI_API_KEY pair counts as configured with nothing saved at all", async (t) => {
	const sqlite = await database(t);
	const base = { DB: sqlite, BUCKET: EMPTY_BUCKET };
	// Nothing saved and no binding or environment endpoint: the default placeholder is not actually usable.
	assert.equal((await loadOnboardingChecklistState(base, OWNER)).assistantConfigured, false);
	// The Workers AI binding: a real, zero-configuration assistant.
	assert.equal((await loadOnboardingChecklistState({ ...base, AI: {} }, OWNER)).assistantConfigured, true);
	// An OpenAI-compatible endpoint set by environment variables, same idea.
	assert.equal(
		(await loadOnboardingChecklistState({ ...base, AI_BASE_URL: "https://ai.example.test", AI_API_KEY: "key" }, OWNER))
			.assistantConfigured,
		true,
	);
});
