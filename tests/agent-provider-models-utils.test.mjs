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
