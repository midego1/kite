import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-provider-models-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src"), "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const constants = await bundle("src/lib/agent/provider-constants.ts", "provider-constants.mjs");
const training = await bundle("src/lib/agent/model-training-utils.ts", "model-training.mjs");
const models = await bundle("src/lib/agent/preset-models-utils.ts", "preset-models.mjs");

test("every preset except custom has a base URL, and Meta points at its OpenAI-compatible endpoint", () => {
	assert.equal(constants.PROVIDER_BASE_URLS.openai, "https://api.openai.com/v1");
	assert.equal(constants.PROVIDER_BASE_URLS.openrouter, "https://openrouter.ai/api/v1");
	assert.equal(constants.PROVIDER_BASE_URLS.groq, "https://api.groq.com/openai/v1");
	assert.equal(constants.PROVIDER_BASE_URLS.meta, "https://api.meta.ai/v1");
});

test("the Meta preset lists both Muse Spark 1.3 models with published rates", () => {
	assert.deepEqual(
		constants.META_AGENT_MODELS.map((model) => model.id),
		["muse-spark-1.3", "muse-spark-1.3-contributor"],
	);
	const [base, contributor] = constants.META_AGENT_MODELS;
	assert.equal(base.name, "Muse Spark 1.3");
	assert.deepEqual(base.rates, { input: 1.25, output: 4.25 });
	assert.equal(base.trainsOnData, undefined);
	assert.equal(contributor.name, "Muse Spark 1.3 (contributor)");
	assert.deepEqual(contributor.rates, { input: 0.1, output: 0.2 });
	assert.equal(contributor.trainsOnData, true);
});

test("only the contributor model is marked as training on the prompts sent to it", () => {
	assert.equal(training.modelTrainsOnData("muse-spark-1.3-contributor"), true);
	assert.equal(training.modelTrainsOnData("muse-spark-1.3"), false);
	assert.equal(training.modelTrainsOnData("gpt-4o-mini"), false);
	assert.equal(training.modelTrainsOnData(""), false);
	assert.equal(
		constants.TRAINING_MODEL_WARNING,
		"Meta may use your prompts and replies, including email content, to train its models.",
	);
});

test("a preset's known models are offered even when no catalog is reachable", () => {
	assert.deepEqual(models.presetAgentModels("meta"), constants.META_AGENT_MODELS);
	assert.deepEqual(models.presetAgentModels("openai"), []);
	assert.deepEqual(models.presetAgentModels("custom"), []);
});

test("known preset models keep their curated details and catalog extras are appended, sorted by name", () => {
	const catalog = [
		{ id: "muse-spark-1.3", name: "A fetched name" },
		{ id: "future-model", name: "Future Model" },
	];
	const merged = models.mergePresetAgentModels(constants.META_AGENT_MODELS, catalog);
	assert.deepEqual(
		merged.map((model) => model.id),
		["future-model", "muse-spark-1.3", "muse-spark-1.3-contributor"],
	);
	const known = merged.find((model) => model.id === "muse-spark-1.3");
	assert.equal(known.name, "Muse Spark 1.3");
	assert.deepEqual(known.rates, { input: 1.25, output: 4.25 });
	assert.deepEqual(models.mergePresetAgentModels([], catalog), catalog);
});
