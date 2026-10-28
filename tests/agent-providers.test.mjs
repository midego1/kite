import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";

/**
 * Saved AI providers (migration 0077): the copy of the one legacy provider into the first saved row, the fallback
 * to the legacy `app_settings` columns before the migration (and while nothing is saved), and which provider every
 * AI feature resolves once several are saved and one is switched to.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const outDir = makeBundleDirectory("kite-agent-providers-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		provider: source("lib/agent/provider.ts"),
		connections: source("lib/agent/provider-connections.ts"),
		connectionUtils: source("lib/agent/provider-connection-utils.ts"),
		admin: source("lib/agent/provider-admin.ts"),
		models: source("lib/agent/provider-models.ts"),
		model: source("lib/agent/model.ts"),
		interactive: source("lib/agent/interactive-model.ts"),
		aiErrors: source("lib/agent/ai-error-utils.ts"),
		backups: source("lib/backups/export.ts"),
		groups: source("lib/backups/table-groups.ts"),
		secrets: source("lib/security/secret-box.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	sourcemap: "inline",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { getAgentProviderConfig, getAgentProviderPublicConfig } = await load("provider");
const {
	ActiveAgentProviderError,
	AgentProvidersPendingError,
	AgentProviderNotFoundError,
	activateAgentProvider,
	createAgentProvider,
	deleteAgentProvider,
	listAgentProviders,
	saveLegacyAgentProvider,
	updateAgentProvider,
} = await load("connections");
const { agentProviderName, publicAgentProvider, savedAgentModelRates, unavailableModelChoice } =
	await load("connectionUtils");
const { prepareAgentProviderValues } = await load("admin");
const { listCompatibleAgentModels } = await load("models");
const { getAgentModel } = await load("model");
const { interactiveRefusal } = await load("interactive");
const { aiErrorMessage, classifyAiError } = await load("aiErrors");
const { exportDatabaseRecords, restoreDatabaseRecords } = await load("backups");
const { BACKUP_TABLE_GROUPS } = await load("groups");
const { sealSecret, isSealed } = await load("secrets");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const scratch = makeBundleDirectory("kite-agent-providers-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const before0077 = copyMigrationsBefore(scratch, 77);
const APP_ENCRYPTION_KEY = "test-encryption-key-for-agent-providers";
const HAIMAKER_KEY = "hm-secret-key-1";
const OPENAI_KEY = "sk-openai-secret-2";

async function database(t, dir = migrationsDir) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, dir);
	return sqlite;
}

const envFor = (sqlite, extra = {}) => ({ DB: sqlite, APP_ENCRYPTION_KEY, ...extra });
const rows = (sqlite) => sqlite.db.prepare("SELECT * FROM agent_providers ORDER BY created_at, id").all();

/** An earlier migration already inserts the `default` row, so the legacy provider is written over it. */
async function seedLegacyProvider(sqlite, values) {
	const columns = Object.keys(values);
	sqlite.db
		.prepare(
			`INSERT INTO app_settings (id, updated_at, ${columns.join(", ")}) VALUES ('default', 1, ${columns.map(() => "?").join(", ")})
			ON CONFLICT (id) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
		)
		.run(...Object.values(values));
}

const haimakerLegacy = async () => ({
	agent_provider: "compatible",
	agent_preset: "haimaker",
	agent_base_url: "https://api.haimaker.ai/v1",
	agent_api_key: await sealSecret(APP_ENCRYPTION_KEY, HAIMAKER_KEY),
	agent_model: "deepseek/deepseek-v3, qwen/qwen3",
	agent_model_rates: JSON.stringify({ "deepseek/deepseek-v3": { input: 0.3, output: 1.2 } }),
});

test("the journal lists 0077_add_agent_providers right after 0076", () => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
	const index = journal.entries.findIndex((entry) => entry.tag === "0077_add_agent_providers");
	assert.ok(index > 0);
	assert.equal(journal.entries[index - 1].tag, "0076_add_import_job_folders");
	assert.equal(journal.entries[index].idx, journal.entries[index - 1].idx + 1);
	assert.ok(journal.entries[index].when > journal.entries[index - 1].when);
});

test("0077 moves the one legacy provider into the first saved provider, in use, key still sealed", async (t) => {
	const sqlite = await database(t, before0077);
	const legacy = await haimakerLegacy();
	await seedLegacyProvider(sqlite, legacy);
	await applyMigrations(sqlite, migrationsDir);

	const [row, ...others] = rows(sqlite);
	assert.equal(others.length, 0);
	assert.equal(row.name, "Haimaker.ai");
	assert.equal(row.provider, "compatible");
	assert.equal(row.preset, "haimaker");
	assert.equal(row.base_url, "https://api.haimaker.ai/v1");
	assert.equal(row.api_key, legacy.agent_api_key, "the sealed key is copied as it is, never opened");
	assert.ok(isSealed(row.api_key));
	assert.equal(row.model, legacy.agent_model);
	assert.equal(row.model_rates, legacy.agent_model_rates);
	assert.equal(row.active, 1);
	assert.ok(row.created_at > 1_700_000_000_000 && row.created_at < 4_000_000_000_000, "milliseconds");
	// The legacy columns stay readable for an older release.
	const settings = sqlite.db.prepare("SELECT agent_api_key, agent_model FROM app_settings").get();
	assert.equal(settings.agent_api_key, legacy.agent_api_key);

	const config = await getAgentProviderConfig(envFor(sqlite));
	assert.equal(config.apiKey, HAIMAKER_KEY);
	assert.equal(config.model, "deepseek/deepseek-v3");
	assert.equal(config.source, "saved");
});

test("0077 names a Workers AI provider and copies nothing when no provider was saved", async (t) => {
	const cloudflare = await database(t, before0077);
	await seedLegacyProvider(cloudflare, { agent_provider: "cloudflare", agent_model: "@cf/meta/llama" });
	await applyMigrations(cloudflare, migrationsDir);
	assert.deepEqual(
		rows(cloudflare).map((row) => [row.name, row.provider, row.preset, row.active]),
		[["Cloudflare Workers AI", "cloudflare", null, 1]],
	);

	const unsaved = await database(t, before0077);
	await seedLegacyProvider(unsaved, { agent_enabled: 1 });
	await applyMigrations(unsaved, migrationsDir);
	assert.deepEqual(rows(unsaved), []);
	const config = await getAgentProviderConfig(envFor(unsaved));
	assert.equal(config.source, "default", "the environment decides, as before");
});

test("before 0077 the provider is read from and saved to the legacy columns", async (t) => {
	const sqlite = await database(t, before0077);
	await seedLegacyProvider(sqlite, await haimakerLegacy());
	const env = envFor(sqlite);

	const config = await getAgentProviderConfig(env);
	assert.deepEqual([config.provider, config.preset, config.apiKey], ["compatible", "haimaker", HAIMAKER_KEY]);
	assert.deepEqual(await listAgentProviders(env), { ready: false, providers: [] });
	await assert.rejects(createAgentProvider(env, { provider: "cloudflare", preset: null, model: "x" }), (error) => {
		assert.ok(error instanceof AgentProvidersPendingError);
		return true;
	});

	const prepared = await prepareAgentProviderValues(
		env,
		{ provider: "compatible", preset: "haimaker", baseUrl: "", model: "glm-4.6", rates: {} },
		"active",
	);
	assert.equal(prepared.error, undefined, "a blank key keeps the legacy key of the same endpoint");
	await saveLegacyAgentProvider(env, prepared.values);
	const saved = await getAgentProviderConfig(env);
	assert.deepEqual([saved.model, saved.apiKey], ["glm-4.6", HAIMAKER_KEY]);
	assert.ok(isSealed(sqlite.db.prepare("SELECT agent_api_key FROM app_settings").get().agent_api_key));
});

test("with saved providers every request resolves the one in use, and switching changes it at once", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite, { AI_ALLOW_INSECURE_LOOPBACK: "1" });
	const values = async (input, target = "new") => {
		const prepared = await prepareAgentProviderValues(env, input, target);
		assert.equal(prepared.error, undefined, prepared.error);
		return prepared.values;
	};

	const haimaker = await createAgentProvider(
		env,
		await values({
			name: "Haimaker",
			provider: "compatible",
			preset: "haimaker",
			baseUrl: "",
			apiKey: HAIMAKER_KEY,
			model: "deepseek/deepseek-v3, qwen/qwen3",
		}),
		{ activate: true },
	);
	const openai = await createAgentProvider(
		env,
		await values({
			name: "  ",
			provider: "compatible",
			preset: "openai",
			baseUrl: "",
			apiKey: OPENAI_KEY,
			model: "gpt-5-mini",
			rates: { "gpt-5-mini": { input: 0.25, output: 2, reasoningEffort: "low" } },
		}),
	);
	let listed = await listAgentProviders(env);
	assert.deepEqual(
		listed.providers.map((provider) => [provider.name, provider.active, provider.hasApiKey]),
		[
			["Haimaker", true, true],
			["OpenAI", false, true],
		],
		"only the provider asked for is used; a blank name gets the provider's name",
	);
	assert.ok(
		rows(sqlite).every((row) => isSealed(row.api_key)),
		"keys are sealed with APP_ENCRYPTION_KEY",
	);
	assert.ok(!JSON.stringify(listed).includes(HAIMAKER_KEY) && !JSON.stringify(listed).includes(OPENAI_KEY));
	assert.ok(!("apiKey" in listed.providers[0]));
	assert.equal((await getAgentProviderConfig(env)).apiKey, HAIMAKER_KEY);

	assert.deepEqual(await activateAgentProvider(env, openai), { name: "OpenAI", previous: "Haimaker" });
	const config = await getAgentProviderConfig(env);
	assert.deepEqual(
		[config.preset, config.baseUrl, config.apiKey, config.model],
		["openai", "https://api.openai.com/v1", OPENAI_KEY, "gpt-5-mini"],
	);
	assert.deepEqual(config.rates["gpt-5-mini"], { input: 0.25, output: 2, reasoningEffort: "low" });
	assert.deepEqual(
		rows(sqlite).map((row) => row.active),
		[0, 1],
		"exactly one provider is in use",
	);
	assert.equal(await activateAgentProvider(env, openai), null, "switching to the provider in use changes nothing");
	const publicConfig = await getAgentProviderPublicConfig(env);
	assert.equal(publicConfig.hasApiKey, true);
	assert.ok(!("apiKey" in publicConfig));

	// Back to Haimaker without typing anything: its key and models were kept.
	await activateAgentProvider(env, haimaker);
	const back = await getAgentProviderConfig(env);
	assert.deepEqual([back.apiKey, back.models], [HAIMAKER_KEY, ["deepseek/deepseek-v3", "qwen/qwen3"]]);

	// Editing a saved provider with a blank key keeps its own key, not the key of the provider in use.
	await updateAgentProvider(
		env,
		openai,
		await values(
			{ name: "OpenAI (team)", provider: "compatible", preset: "openai", baseUrl: "", model: "gpt-5" },
			{ id: openai },
		),
	);
	await activateAgentProvider(env, openai);
	assert.deepEqual(
		[(await getAgentProviderConfig(env)).apiKey, (await listAgentProviders(env)).providers[1].name],
		[OPENAI_KEY, "OpenAI (team)"],
	);
	const newWithoutKey = await prepareAgentProviderValues(
		env,
		{ provider: "compatible", preset: "openai", baseUrl: "", model: "gpt-5" },
		"new",
	);
	assert.equal(newWithoutKey.error, "Enter an API key for this provider", "a new provider never borrows a key");

	await assert.rejects(deleteAgentProvider(env, openai), (error) => error instanceof ActiveAgentProviderError);
	assert.deepEqual(await deleteAgentProvider(env, haimaker), { name: "Haimaker" });
	listed = await listAgentProviders(env);
	assert.deepEqual(
		listed.providers.map((provider) => provider.id),
		[openai],
	);
});

test("the legacy provider form saves into the provider in use and keeps a typed name", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite, { AI_ALLOW_INSECURE_LOOPBACK: "1" });
	let id = null;
	const prepare = async (input) => (await prepareAgentProviderValues(env, input, id ? { id } : "active")).values;
	id = await createAgentProvider(
		env,
		await prepare({ provider: "compatible", preset: "haimaker", baseUrl: "", apiKey: HAIMAKER_KEY, model: "a" }),
		{ activate: true },
	);
	assert.equal((await listAgentProviders(env)).providers[0].name, "Haimaker.ai");
	await updateAgentProvider(
		env,
		id,
		await prepare({ provider: "compatible", preset: "groq", baseUrl: "", apiKey: "gsk", model: "b" }),
	);
	assert.equal((await listAgentProviders(env)).providers[0].name, "Groq", "a default name follows the provider");
	await updateAgentProvider(
		env,
		id,
		await prepare({ name: "Mine", provider: "compatible", preset: "groq", baseUrl: "", model: "b" }),
	);
	await updateAgentProvider(
		env,
		id,
		await prepare({ provider: "compatible", preset: "openai", baseUrl: "", apiKey: "sk", model: "c" }),
	);
	assert.equal((await listAgentProviders(env)).providers[0].name, "Mine", "a typed name stays");
});

test("an empty table falls back to the legacy columns, as after restoring an older backup", async (t) => {
	const sqlite = await database(t);
	await seedLegacyProvider(sqlite, await haimakerLegacy());
	const config = await getAgentProviderConfig(envFor(sqlite));
	assert.deepEqual([config.preset, config.apiKey, config.source], ["haimaker", HAIMAKER_KEY, "saved"]);
});

test("names, public rows and model fallbacks", () => {
	assert.equal(agentProviderName(undefined, "cloudflare", null), "Cloudflare Workers AI");
	assert.equal(agentProviderName("  Work  ", "compatible", "haimaker"), "Work");
	assert.equal(agentProviderName("x".repeat(100), "compatible", "custom").length, 80);
	const row = {
		id: "aip_1",
		name: "Haimaker",
		provider: "compatible",
		preset: "haimaker",
		baseUrl: "https://api.haimaker.ai/v1",
		apiKey: "enc:v1:sealed",
		model: "a, b",
		rates: null,
		active: true,
		createdAt: new Date(0),
	};
	assert.deepEqual(publicAgentProvider(row), {
		id: "aip_1",
		name: "Haimaker",
		provider: "compatible",
		preset: "haimaker",
		baseUrl: "https://api.haimaker.ai/v1",
		model: "a",
		models: ["a", "b"],
		rates: {},
		hasApiKey: true,
		keyUnreadable: false,
		active: true,
	});
	assert.deepEqual(
		publicAgentProvider({ ...row, provider: "cloudflare", preset: null, baseUrl: null, apiKey: null, model: "" }),
		{
			id: "aip_1",
			name: "Haimaker",
			provider: "cloudflare",
			preset: "openai",
			baseUrl: "",
			model: "",
			models: [],
			rates: {},
			hasApiKey: false,
			keyUnreadable: false,
			active: true,
		},
	);
	assert.equal(agentProviderName("", "compatible", null), "Custom endpoint");
	assert.equal(
		savedAgentModelRates(["m", "n"], {
			m: { input: 1, output: 2, reasoningEffort: "high" },
			x: { input: 9, output: 9 },
		}),
		JSON.stringify({ m: { input: 1, output: 2, reasoningEffort: "high" }, n: { input: null, output: null } }),
	);
	assert.equal(unavailableModelChoice("a", ["a", "b"], "a"), null);
	assert.equal(unavailableModelChoice(null, ["a"], "a"), null);
	assert.deepEqual(unavailableModelChoice("old/model", ["a", "b"], "a"), { saved: "old/model", using: "a" });
	assert.deepEqual(unavailableModelChoice("old/model", ["a"], null), { saved: "old/model", using: null });
});

const legacyColumns = (sqlite) =>
	sqlite.db
		.prepare(
			"SELECT agent_provider, agent_preset, agent_base_url, agent_api_key, agent_model, agent_model_rates FROM app_settings WHERE id = 'default'",
		)
		.get();
const NO_LEGACY = {
	agent_provider: null,
	agent_preset: null,
	agent_base_url: null,
	agent_api_key: null,
	agent_model: null,
	agent_model_rates: null,
};

async function prepared(env, input, target = "new") {
	const result = await prepareAgentProviderValues(env, input, target);
	assert.equal(result.error, undefined, result.error);
	return result.values;
}

const openaiInput = (apiKey = OPENAI_KEY) => ({
	name: "OpenAI",
	provider: "compatible",
	preset: "openai",
	baseUrl: "",
	apiKey,
	model: "gpt-5-mini",
});

test("once a saved provider is in use the legacy columns are cleared, and deleting the copied provider leaves no key", async (t) => {
	const sqlite = await database(t, before0077);
	const legacy = await haimakerLegacy();
	await seedLegacyProvider(sqlite, legacy);
	await applyMigrations(sqlite, migrationsDir);
	const env = envFor(sqlite);
	assert.equal(legacyColumns(sqlite).agent_api_key, legacy.agent_api_key, "the migration itself keeps them");

	// Saving the provider in use clears them.
	await updateAgentProvider(
		env,
		"aip_migrated",
		await prepared(
			env,
			{ provider: "compatible", preset: "haimaker", baseUrl: "", model: "glm-4.6" },
			{ id: "aip_migrated" },
		),
	);
	assert.deepEqual(legacyColumns(sqlite), NO_LEGACY);
	assert.equal((await getAgentProviderConfig(env)).apiKey, HAIMAKER_KEY, "the saved provider kept its key");

	// A provider added but not used leaves them alone; switching to it clears them.
	await seedLegacyProvider(sqlite, legacy);
	const openai = await createAgentProvider(env, await prepared(env, openaiInput()));
	assert.equal(legacyColumns(sqlite).agent_api_key, legacy.agent_api_key);
	await activateAgentProvider(env, openai);
	assert.deepEqual(legacyColumns(sqlite), NO_LEGACY);

	// Deleting the copied provider removes the copy of its key the legacy columns might still hold.
	await seedLegacyProvider(sqlite, legacy);
	await deleteAgentProvider(env, "aip_migrated");
	assert.deepEqual(legacyColumns(sqlite), NO_LEGACY);
	const everything = JSON.stringify([
		sqlite.db.prepare("SELECT * FROM agent_providers").all(),
		sqlite.db.prepare("SELECT * FROM app_settings").all(),
	]);
	assert.ok(!everything.includes(legacy.agent_api_key), "the Haimaker key is gone from the database");
});

test("a saved provider that is not in use never replaces the legacy provider in use", async (t) => {
	const sqlite = await database(t);
	await seedLegacyProvider(sqlite, await haimakerLegacy());
	const env = envFor(sqlite);
	await createAgentProvider(env, await prepared(env, openaiInput()));
	const config = await getAgentProviderConfig(env);
	assert.deepEqual([config.preset, config.apiKey], ["haimaker", HAIMAKER_KEY]);
	assert.equal(legacyColumns(sqlite).agent_preset, "haimaker");
});

test("a key sealed under another APP_ENCRYPTION_KEY is reported, never thrown, and can be entered again", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite);
	const haimaker = await createAgentProvider(
		env,
		await prepared(env, { provider: "compatible", preset: "haimaker", baseUrl: "", apiKey: HAIMAKER_KEY, model: "a" }),
		{ activate: true },
	);
	const openai = await createAgentProvider(env, await prepared(env, openaiInput()));
	const restored = { ...env, APP_ENCRYPTION_KEY: "a-different-key-after-a-restore" };

	const config = await getAgentProviderConfig(restored);
	assert.deepEqual([config.apiKey, config.keyUnreadable], ["", true]);
	const publicConfig = await getAgentProviderPublicConfig(restored);
	assert.deepEqual([publicConfig.configured, publicConfig.keyUnreadable, publicConfig.hasApiKey], [false, true, false]);
	const listed = await listAgentProviders(restored);
	assert.deepEqual(
		listed.providers.map((provider) => [provider.keyUnreadable, provider.hasApiKey]),
		[
			[true, false],
			[true, false],
		],
	);

	// AI requests say why they cannot run.
	await assert.rejects(getAgentModel(restored), (error) => {
		assert.equal(classifyAiError(error).code, "provider_key_unreadable");
		return true;
	});
	assert.equal(await interactiveRefusal(restored), "provider_key_unreadable");
	assert.match(aiErrorMessage("provider_key_unreadable"), /can't be read/);

	// Switching works, a blank key is refused with the reason, and a typed key needs no stored key opened.
	assert.deepEqual(await activateAgentProvider(restored, openai), { name: "OpenAI", previous: "Haimaker.ai" });
	const blank = await prepareAgentProviderValues(restored, { ...openaiInput(""), apiKey: undefined }, { id: openai });
	assert.equal(blank.error, "The saved API key can't be read. Enter it again.");
	const typed = await prepareAgentProviderValues(restored, openaiInput("sk-new"), "active");
	assert.equal(typed.keyReplaced, true);
	await updateAgentProvider(restored, openai, typed.values);
	assert.deepEqual(
		[(await getAgentProviderConfig(restored)).apiKey, (await getAgentProviderConfig(restored)).keyUnreadable],
		["sk-new", undefined],
	);
	assert.ok(haimaker);
});

test("switching is one statement in any row order, and a missing id changes nothing", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite);
	const ids = [];
	for (const key of ["k1", "k2", "k3"]) ids.push(await createAgentProvider(env, await prepared(env, openaiInput(key))));
	assert.deepEqual(
		rows(sqlite).map((row) => row.active),
		[0, 0, 0],
	);
	await activateAgentProvider(env, ids[2]);
	// The first row comes before the active one: a partial unique index would refuse this statement midway.
	await activateAgentProvider(env, ids[0]);
	assert.deepEqual(
		sqlite.db
			.prepare("SELECT id, active FROM agent_providers ORDER BY rowid")
			.all()
			.map((row) => row.active),
		[1, 0, 0],
	);
	await activateAgentProvider(env, ids[1]);
	assert.equal(sqlite.db.prepare("SELECT count(*) AS n FROM agent_providers WHERE active = 1").get().n, 1);
	await assert.rejects(activateAgentProvider(env, "aip_gone"), (error) => error instanceof AgentProviderNotFoundError);
	assert.equal(sqlite.db.prepare("SELECT id FROM agent_providers WHERE active = 1").get().id, ids[1]);
});

test("a blank key on AI_BASE_URL relies on AI_API_KEY and never copies it into the database", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite, { AI_BASE_URL: "https://llm.example.test/v1", AI_API_KEY: "env-secret-key" });
	const values = await prepared(
		env,
		{ provider: "compatible", preset: "custom", baseUrl: "https://llm.example.test/v1", model: "m" },
		"active",
	);
	assert.equal(values.apiKey, null);
	await createAgentProvider(env, values, { activate: true });
	assert.equal(rows(sqlite)[0].api_key, null);
	assert.equal((await getAgentProviderConfig(env)).apiKey, "env-secret-key");
	assert.equal((await listAgentProviders(env)).providers[0].hasApiKey, true);
	const elsewhere = await prepareAgentProviderValues(
		env,
		{ provider: "compatible", preset: "custom", baseUrl: "https://other.example.test/v1", model: "m" },
		"new",
	);
	assert.equal(elsewhere.error, "Enter an API key for this provider");
});

test("loading models for a saved provider uses only that provider's key, and only for its own endpoint", async (t) => {
	const sqlite = await database(t);
	const env = envFor(sqlite);
	await createAgentProvider(
		env,
		await prepared(env, { provider: "compatible", preset: "haimaker", baseUrl: "", apiKey: HAIMAKER_KEY, model: "a" }),
		{ activate: true },
	);
	const openai = await createAgentProvider(env, await prepared(env, openaiInput()));
	const sent = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		sent.push({ url: String(url), authorization: init.headers.Authorization });
		return new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200 });
	};
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const load = (input) => listCompatibleAgentModels(env, { baseUrl: "", ...input });
	await load({ preset: "openai", providerId: openai });
	assert.deepEqual(sent.pop(), { url: "https://api.openai.com/v1/models", authorization: `Bearer ${OPENAI_KEY}` });
	for (const input of [
		{ preset: "groq", providerId: openai },
		{ preset: "custom", baseUrl: "https://api.openai.com/v2", providerId: openai },
		{ preset: "haimaker", providerId: openai },
		{ preset: "haimaker", providerId: null },
		{ preset: "openai", providerId: "aip_missing" },
	])
		await assert.rejects(load(input), /Enter an API key to load models/, JSON.stringify(input));
	assert.deepEqual(sent, [], "no request carried a borrowed key");
	await load({ preset: "haimaker" });
	assert.equal(sent.pop().authorization, `Bearer ${HAIMAKER_KEY}`, "omitted means the provider in use");
});

const exportDocument = async (sqlite) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(sqlite)));
const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;

test("saved providers survive a backup round trip, and an older backup clears them back to its legacy provider", async (t) => {
	assert.deepEqual(
		BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes("agent_providers")).map((group) => group.id),
		["system"],
	);
	const source = await database(t);
	const env = envFor(source);
	const haimaker = await createAgentProvider(
		env,
		await prepared(env, { provider: "compatible", preset: "haimaker", baseUrl: "", apiKey: HAIMAKER_KEY, model: "a" }),
		{ activate: true },
	);
	await createAgentProvider(env, await prepared(env, openaiInput()));
	const document = await exportDocument(source);
	assert.equal(document.tables.agent_providers.length, 2);
	assert.ok(
		document.tables.agent_providers.every((row) => isSealed(row.api_key)),
		"keys stay sealed in the backup",
	);

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	const restoredEnv = envFor(target);
	assert.deepEqual(rows(target), rows(source));
	assert.equal((await listAgentProviders(restoredEnv)).providers.find((row) => row.active)?.id, haimaker);
	assert.equal((await getAgentProviderConfig(restoredEnv)).apiKey, HAIMAKER_KEY);

	// A backup made before 0077 has no agent_providers: the restore empties the table and its legacy provider is used.
	const older = await database(t, before0077);
	await seedLegacyProvider(older, {
		agent_provider: "compatible",
		agent_preset: "groq",
		agent_base_url: "https://api.groq.com/openai/v1",
		agent_api_key: await sealSecret(APP_ENCRYPTION_KEY, "gsk-old"),
		agent_model: "llama",
	});
	const olderDocument = await exportDocument(older);
	assert.deepEqual(olderDocument.tables.agent_providers ?? [], []);
	// A release before 0077 did not know the table at all.
	delete olderDocument.tables.agent_providers;
	olderDocument.includedTables = olderDocument.includedTables.filter((table) => table !== "agent_providers");
	await restoreDatabaseRecords(target, encode(olderDocument));
	assert.deepEqual(rows(target), []);
	const config = await getAgentProviderConfig(restoredEnv);
	assert.deepEqual([config.preset, config.apiKey], ["groq", "gsk-old"]);
});
