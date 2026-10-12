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

await build({
	entryPoints: [join(root, "src/lib/agent/provider-models-utils.ts")],
	outfile: join(outDir, "provider-models-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { compatibleModelsRequest, parseCompatibleAgentModelOptions } = await import(
	pathToFileURL(join(outDir, "provider-models-utils.mjs")).href
);

test("Haimaker model catalog uses the OpenAI-compatible endpoint and parses model IDs dynamically", () => {
	const request = compatibleModelsRequest("haimaker", "https://api.haimaker.ai/v1", "haimaker-key");
	assert.equal(request.url, "https://api.haimaker.ai/v1/models");
	assert.deepEqual(request.headers, {
		Authorization: "Bearer haimaker-key",
		Accept: "application/json",
	});

	const models = parseCompatibleAgentModelOptions(
		[
			{ id: "deepseek/deepseek-v4", name: "DeepSeek V4" },
			{ id: "qwen/qwen3.8-max" },
			{ id: "z-ai/glm-5.3" },
			{ id: "moonshotai/kimi-k3" },
			{ id: "minimax/minimax-m3" },
		],
		"haimaker",
	);
	assert.deepEqual(
		models.map(({ id }) => id).sort(),
		["deepseek/deepseek-v4", "minimax/minimax-m3", "moonshotai/kimi-k3", "qwen/qwen3.8-max", "z-ai/glm-5.3"].sort(),
	);
});

test("Anthropic catalog uses its native authentication and exposes current model display names", () => {
	const request = compatibleModelsRequest("anthropic", "https://api.anthropic.com/v1", "anthropic-key");
	assert.equal(request.url, "https://api.anthropic.com/v1/models?limit=1000");
	assert.deepEqual(request.headers, {
		"x-api-key": "anthropic-key",
		"anthropic-version": "2023-06-01",
		Accept: "application/json",
	});

	assert.deepEqual(
		parseCompatibleAgentModelOptions([{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }], "anthropic"),
		[{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", rates: undefined }],
	);
});

test("OpenRouter catalog converts per-token pricing to USD per million and drops unpriceable models", () => {
	const request = compatibleModelsRequest("openrouter", "https://openrouter.ai/api/v1", "openrouter-key");
	assert.equal(request.url, "https://openrouter.ai/api/v1/models");
	assert.deepEqual(request.headers, {
		Authorization: "Bearer openrouter-key",
		Accept: "application/json",
	});

	const models = parseCompatibleAgentModelOptions(
		[
			{
				id: "deepseek/deepseek-chat",
				name: "DeepSeek Chat",
				pricing: { prompt: "0.00000025", completion: "0.000001" },
			},
			{ id: "broken/prices", name: "Broken Prices", pricing: { prompt: "not-a-number", completion: 0 } },
			{ id: "no/pricing", name: "No Pricing" },
		],
		"openrouter",
	);
	assert.deepEqual(models.find((item) => item.id === "deepseek/deepseek-chat")?.rates, { input: 0.25, output: 1 });
	assert.equal(models.find((item) => item.id === "broken/prices")?.rates, undefined);
	assert.equal(models.find((item) => item.id === "no/pricing")?.rates, undefined);
});
