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
	activateAgentProvider,
	createAgentProvider,
	deleteAgentProvider,
	listAgentProviders,
	saveLegacyAgentProvider,
	updateAgentProvider,
} = await load("connections");
const { agentProviderName, publicAgentProvider, savedAgentModelRates, sortAgentProviders, unavailableModelChoice } =
	await load("connectionUtils");
const { prepareAgentProviderValues } = await load("admin");
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
		"the first provider is used at once; a blank name gets the provider's name",
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
	const prepare = async (input) => (await prepareAgentProviderValues(env, input, "active")).values;
	const id = await createAgentProvider(
		env,
		await prepare({ provider: "compatible", preset: "haimaker", baseUrl: "", apiKey: HAIMAKER_KEY, model: "a" }),
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
			active: true,
		},
	);
	assert.equal(agentProviderName("", "compatible", null), "Custom endpoint");
	assert.deepEqual(
		sortAgentProviders([
			{ id: "b", createdAt: new Date(2) },
			{ id: "c", createdAt: new Date(1) },
			{ id: "a", createdAt: new Date(2) },
		]).map((item) => item.id),
		["c", "a", "b"],
	);
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
