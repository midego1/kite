import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Automatic reading against a fake Anthropic Messages API: Claude 5 models think by default, thinking counts
// against max_tokens, and a 400-token triage answer used to be spent thinking and cut off (`cut_off`).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-anthropic-thinking-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(path));
await build({
	stdin: {
		contents: [
			`export * from ${JSON.stringify(source("../src/lib/agent/auto-read/model-call-utils.ts"))};`,
			`export { generateTriageText } from ${JSON.stringify(source("../src/lib/agent/auto-read/triage-model.ts"))};`,
			`export { classifyAiError } from ${JSON.stringify(source("../src/lib/agent/ai-error-utils.ts"))};`,
			`export { explainCutOff, cutOffFacts } from ${JSON.stringify(source("../src/lib/agent/cut-off-utils.ts"))};`,
		].join("\n"),
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "anthropic-thinking.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	// The test's own provider and the bundle must share one AI SDK.
	external: ["ai", "@ai-sdk/*"],
});
const kite = await import(pathToFileURL(join(outDir, "anthropic-thinking.mjs")).href);
const { buildModelCallOptions, runTriageAttempt, generateTriageText, classifyAiError, explainCutOff, cutOffFacts } =
	kite;

const prompt = { system: "s", messages: [{ role: "user", content: "an email" }] };
const ANSWER = JSON.stringify({ category: "fyi", needsReply: false, summary: "A short note." });

/**
 * A fake Messages API. `thinks(body)` says whether the model thinks for this request; a thinking model fills
 * max_tokens with thinking (stop_reason max_tokens), the way Haiku 5.5 did with Kite's 400-token cap.
 */
function fakeAnthropic({ thinks, answerFits = () => true }) {
	const bodies = [];
	const fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		bodies.push(body);
		const message = (content, stop, output, thinking) => ({
			id: `msg_${bodies.length}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content,
			stop_reason: stop,
			stop_sequence: null,
			usage: { input_tokens: 900, output_tokens: output, output_tokens_details: { thinking_tokens: thinking } },
		});
		const reply = thinks(body)
			? message([{ type: "thinking", thinking: "", signature: "sig" }], "max_tokens", body.max_tokens, body.max_tokens)
			: answerFits(body)
				? message([{ type: "text", text: ANSWER }], "end_turn", 40, 0)
				: message([{ type: "text", text: ANSWER.slice(0, 30) }], "max_tokens", body.max_tokens, 0);
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	};
	const provider = createAnthropic({ apiKey: "test-key", baseURL: "http://anthropic.test/v1", fetch });
	return { bodies, provider };
}

/** Claude 5 thinking defaults: thinks unless `thinking: disabled` is sent; Opus 5.5 always thinks below 3,000. */
const thinksUnlessDisabled = (body) => body.thinking?.type !== "disabled";

function options(modelId, extra = {}) {
	return buildModelCallOptions({ provider: "compatible", preset: "anthropic", kind: "triage", modelId, ...extra });
}

function attempt(fake, modelId, callOptions = options(modelId)) {
	return runTriageAttempt({
		prompt,
		options: callOptions,
		generate: (request, current) => generateTriageText(fake.provider(modelId), request, current),
	});
}

test("without Kite's thinking setting, Haiku 5.5 spends the 400-token cap thinking and is cut off", async () => {
	// The request Kite used to send: no `thinking`, no effort, 400 tokens.
	const fake = fakeAnthropic({ thinks: thinksUnlessDisabled });
	const before = { ...options("claude-haiku-5-5"), providerOptions: { anthropic: {} } };
	const reply = await generateTriageText(fake.provider("claude-haiku-5-5"), prompt, before);
	assert.equal(reply.finishReason, "length");
	assert.equal(reply.usage.outputTokens, 400);
	assert.equal(reply.usage.outputTokenDetails.reasoningTokens, 400);
	assert.equal(fake.bodies[0].max_tokens, 400);
	assert.equal(fake.bodies[0].thinking, undefined);
});

test("Kite switches Haiku 5.5's thinking off, so the triage answer fits in one call", async () => {
	const fake = fakeAnthropic({ thinks: thinksUnlessDisabled });
	const { result, calls } = await attempt(fake, "claude-haiku-5-5");
	assert.equal(calls, 1);
	assert.equal(result.category, "fyi");
	assert.deepEqual(fake.bodies[0].thinking, { type: "disabled" });
	assert.equal(fake.bodies[0].max_tokens, 400);
	assert.equal(fake.bodies[0].output_config?.effort, undefined);
	// Structured output still goes along.
	assert.equal(fake.bodies[0].output_config?.format?.type, "json_schema");
});

test("a model that always thinks gets effort low and the thinking room, then one retry at double the cap", async () => {
	const fake = fakeAnthropic({ thinks: (body) => body.max_tokens < 3_000 });
	const { result, calls } = await attempt(fake, "claude-opus-5-5");
	assert.equal(result.category, "fyi");
	assert.equal(calls, 2);
	assert.deepEqual(
		fake.bodies.map((body) => [body.max_tokens, body.output_config?.effort, body.thinking]),
		[
			[1_500, "low", undefined],
			[3_000, "low", undefined],
		],
	);
});

test("a second cut-off fails with the cap, the thinking setting and the usage for Why?", async () => {
	const fake = fakeAnthropic({ thinks: () => false, answerFits: () => false });
	const error = await attempt(fake, "claude-haiku-5-5").then(
		() => assert.fail("expected a cut-off"),
		(caught) => caught,
	);
	assert.equal(error.name, "ModelOutputTruncatedError");
	assert.deepEqual(
		fake.bodies.map((body) => body.max_tokens),
		[400, 800],
	);
	const failure = classifyAiError(error);
	assert.equal(failure.code, "cut_off");
	assert.deepEqual(failure.budget, {
		cap: 800,
		thinkingRoom: 0,
		extensionRoom: 0,
		thinking: "off",
		effort: null,
		retried: true,
		used: 800,
		thinkingUsed: 0,
	});
	const input = {
		provider: "Anthropic",
		providerId: "anthropic",
		model: "claude-haiku-5-5",
		feature: "auto_triage",
		budget: failure.budget,
	};
	const { cause, fix } = explainCutOff(input);
	assert.match(cause, /^Automatic reading capped claude-haiku-5-5's answer at 800 tokens/);
	assert.match(cause, /used 800 output tokens/);
	assert.match(cause, /Thinking was off\. Kite had already retried once with double the cap\./);
	assert.match(fix, /answer itself ran long, even at double the cap/);
	assert.deepEqual(cutOffFacts(input), [
		{ label: "Output cap", value: "800 tokens" },
		{ label: "Thinking", value: "off" },
		{ label: "Used", value: "800 output tokens" },
		{ label: "Retry", value: "cut off again at double the cap" },
	]);
});

test("module extensions widen the cap and the retry doubles it, and the reservation sees each cap", async () => {
	const fake = fakeAnthropic({ thinks: thinksUnlessDisabled, answerFits: (body) => body.max_tokens >= 1_000 });
	const extension = { outputTokens: 260, schema: { type: "object", properties: {}, additionalProperties: true } };
	const reserved = [];
	const callOptions = options("claude-haiku-5-5", { extension });
	const { calls } = await runTriageAttempt({
		prompt,
		options: callOptions,
		generate: (request, current) => {
			reserved.push(current.maxOutputTokens);
			return generateTriageText(fake.provider("claude-haiku-5-5"), request, current);
		},
	});
	assert.equal(calls, 2);
	assert.deepEqual(reserved, [660, 1_320]);
	assert.deepEqual(
		fake.bodies.map((body) => body.max_tokens),
		reserved,
	);
});
