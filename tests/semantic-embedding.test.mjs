import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses embedding.ts, so its exports below are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/embedding.ts");

const { EMBEDDING_DIMENSIONS, EmbeddingDimensionMismatchError, resolvedEmbeddingProviderKind, getEmbeddingProvider } =
	await bundleModules("kite-semantic-embedding-", [
		[
			"EMBEDDING_DIMENSIONS, EmbeddingDimensionMismatchError, resolvedEmbeddingProviderKind, getEmbeddingProvider",
			"src/lib/semantic/embedding.ts",
		],
	]);

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
