import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses embedding.ts, so its exports below are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/embedding.ts");

const {
	SqliteDatabase,
	applyMigrations,
	EMBEDDING_DIMENSIONS,
	EmbeddingDimensionMismatchError,
	EmbeddingProviderUnavailableError,
	resolvedEmbeddingProviderKind,
	getEmbeddingProvider,
} = await bundleModules("kite-semantic-embedding-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	[
		"EMBEDDING_DIMENSIONS, EmbeddingDimensionMismatchError, EmbeddingProviderUnavailableError, resolvedEmbeddingProviderKind, getEmbeddingProvider",
		"src/lib/semantic/embedding.ts",
	],
]);

const scratch = makeBundleDirectory("kite-semantic-embedding-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function compatibleEnv(t, compatibleBaseUrl) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	db.db
		.prepare(
			`INSERT INTO app_settings (id, semantic_embedding_provider, semantic_compatible_base_url, updated_at) VALUES ('default', 'compatible', ?, 1)
			ON CONFLICT(id) DO UPDATE SET semantic_embedding_provider = 'compatible', semantic_compatible_base_url = ?`,
		)
		.run(compatibleBaseUrl, compatibleBaseUrl);
	return { DB: db };
}

test("the binding resolves to workers_ai whenever env.AI is set, whatever else is configured", async () => {
	assert.equal(await resolvedEmbeddingProviderKind({ AI: {} }), "workers_ai");
});

test("the Workers AI REST API (CF_ACCOUNT_ID and CF_TOKEN) also counts as workers_ai, not compatible", async () => {
	assert.equal(await resolvedEmbeddingProviderKind({ CF_ACCOUNT_ID: "acc", CF_TOKEN: "tok" }), "workers_ai");
	assert.equal(await resolvedEmbeddingProviderKind({ CF_ACCOUNT_ID: "acc" }), "compatible");
	assert.equal(await resolvedEmbeddingProviderKind({}), "compatible");
});

test("the Workers AI binding returns vectors of exactly EMBEDDING_DIMENSIONS", async () => {
	const env = {
		AI: {
			run: async (_model, input) => ({
				data: input.text.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)),
			}),
		},
	};
	const provider = await getEmbeddingProvider(env);
	assert.equal(provider.kind, "workers_ai");
	assert.equal(provider.dimensions, EMBEDDING_DIMENSIONS);
	const { vectors, inputTokens } = await provider.embedTexts(["hello world"]);
	assert.equal(vectors.length, 1);
	assert.equal(vectors[0].length, EMBEDDING_DIMENSIONS);
	assert.ok(inputTokens > 0);
});

test("a provider that returns the wrong number of dimensions is refused with EmbeddingDimensionMismatchError", async () => {
	const env = { AI: { run: async () => ({ data: [[1, 2, 3]] }) } };
	const provider = await getEmbeddingProvider(env);
	await assert.rejects(() => provider.embedTexts(["hello"]), EmbeddingDimensionMismatchError);
});

test("batches of more than 32 texts are split into separate calls", async () => {
	const calls = [];
	const env = {
		AI: {
			run: async (_model, input) => {
				calls.push(input.text.length);
				return { data: input.text.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)) };
			},
		},
	};
	const provider = await getEmbeddingProvider(env);
	const texts = Array.from({ length: 70 }, (_, index) => `text ${index}`);
	const { vectors } = await provider.embedTexts(texts);
	assert.equal(vectors.length, 70);
	assert.deepEqual(calls, [32, 32, 6]);
});

test("a hanging Workers AI binding call times out instead of holding a drain batch's lease forever", async () => {
	const env = {
		AI: { run: () => new Promise(() => {}) },
		AI_ALLOW_INSECURE_LOOPBACK: "1",
		AI_TEST_TIMEOUT_MS: "50",
	};
	const provider = await getEmbeddingProvider(env);
	await assert.rejects(() => provider.embedTexts(["hello"]), /timed out/);
});

test("a compatible base URL that is not HTTPS is refused, even one saved before this check existed", async (t) => {
	const env = await compatibleEnv(t, "http://attacker.example");
	await assert.rejects(() => getEmbeddingProvider(env), EmbeddingProviderUnavailableError);
});

test("a compatible base URL with embedded credentials is refused", async (t) => {
	const env = await compatibleEnv(t, "https://user:pass@provider.example");
	await assert.rejects(() => getEmbeddingProvider(env), EmbeddingProviderUnavailableError);
});

test("a plain HTTPS compatible base URL is accepted", async (t) => {
	const env = await compatibleEnv(t, "https://provider.example/v1");
	const provider = await getEmbeddingProvider(env);
	assert.equal(provider.kind, "compatible");
});
