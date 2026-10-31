import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { REPAIR_MARKER } from "../src/lib/agent/auto-read/request-markers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-model-call-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which module this test uses.
await build({
	entryPoints: [fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/model-call-utils.ts"))],
	outfile: join(outDir, "model-call.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const calls = await import(pathToFileURL(join(outDir, "model-call.mjs")).href);
const {
	buildModelCallOptions,
	callWithFallback,
	chooseTriageModelId,
	completedText,
	fallbackOptionsAfterError,
	runTriageAttempt,
	ModelOutputTruncatedError,
	TriageOutputError,
} = calls;

const validTriage = JSON.stringify({ category: "fyi", needsReply: false });
const prompt = { system: "s", messages: [{ role: "user", content: "[[scenario:x]]" }] };
const apiError = (statusCode, message, responseBody) => Object.assign(new Error(message), { statusCode, responseBody });

test("Workers AI: thinking off and JSON mode under the workersAi key, no reasoning effort", () => {
	const triage = buildModelCallOptions({ provider: "cloudflare", kind: "triage", reasoningEffort: "minimal" });
	assert.equal(calls.COMPATIBLE_PROVIDER_NAME, "kite");
	assert.equal(triage.maxOutputTokens, 400);
	assert.equal(triage.reasoningEffort, null);
	assert.deepEqual(triage.providerOptions.workersAi, {
		chat_template_kwargs: { thinking: false },
		response_format: { type: "json_object" },
	});
	assert.deepEqual(triage.providerOptions["workers-ai"], triage.providerOptions.workersAi);
	const draft = buildModelCallOptions({ provider: "cloudflare", kind: "draft" });
	assert.equal(draft.maxOutputTokens, 900);
	assert.deepEqual(draft.providerOptions.workersAi, { chat_template_kwargs: { thinking: false } });
	assert.equal(draft.jsonMode, false);
});

test("compatible: reasoningEffort only with a hint, never none, and the matching budget", () => {
	const plain = buildModelCallOptions({ provider: "compatible", kind: "triage" });
	assert.equal(plain.maxOutputTokens, 400);
	assert.deepEqual(plain.providerOptions, { kite: { response_format: { type: "json_object" } } });
	const hinted = buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: "minimal" });
	assert.equal(hinted.maxOutputTokens, 1_500);
	assert.deepEqual(hinted.providerOptions, {
		kite: { response_format: { type: "json_object" }, reasoningEffort: "minimal" },
	});
	for (const effort of ["none", "turbo", 3, null]) {
		const options = buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: effort });
		assert.equal(options.maxOutputTokens, 400, String(effort));
		assert.ok(!("reasoningEffort" in options.providerOptions.kite));
		assert.ok(!JSON.stringify(options).includes('"none"'));
	}
	const draft = buildModelCallOptions({ provider: "compatible", kind: "draft", reasoningEffort: "max" });
	assert.equal(draft.maxOutputTokens, 2_000);
	assert.deepEqual(draft.providerOptions, { kite: { reasoningEffort: "max" } });
	assert.equal(buildModelCallOptions({ provider: "compatible", kind: "draft" }).maxOutputTokens, 900);
});

test("native Anthropic sends its supported effort hint without OpenAI-only options", () => {
	const options = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "triage",
		reasoningEffort: "high",
	});
	assert.equal(options.preset, "anthropic");
	assert.equal(options.maxOutputTokens, 1_500);
	assert.deepEqual(options.providerOptions, { anthropic: { effort: "high" } });
	assert.equal(options.jsonMode, true);
});

test("Anthropic: thinking off where the model allows it, effort low where it always thinks", () => {
	const anthropic = (modelId, extra = {}) =>
		buildModelCallOptions({ provider: "compatible", preset: "anthropic", kind: "triage", modelId, ...extra });
	// Claude 5 models think by default when `thinking` is left out, and thinking counts against max_tokens.
	for (const modelId of ["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-next-9"]) {
		const options = anthropic(modelId);
		assert.deepEqual(options.providerOptions, { anthropic: { thinking: { type: "disabled" } } }, modelId);
		assert.equal(options.maxOutputTokens, 400, modelId);
		assert.equal(options.thinking, "off", modelId);
		assert.equal(options.thinkingRoom, 0, modelId);
	}
	// Sonnet 5.5 refuses `disabled`; its lowest setting skips thinking before the answer, and is not called "off".
	const sonnet = anthropic("claude-sonnet-5-5");
	assert.deepEqual(sonnet.providerOptions, { anthropic: { thinking: { type: "between_tools" } } });
	assert.equal(sonnet.thinking, "between_tools");
	assert.equal(sonnet.maxOutputTokens, 400);
	// `minimal` has no Anthropic effort: as little thinking as the model allows.
	assert.deepEqual(anthropic("claude-haiku-5-5", { reasoningEffort: "minimal" }).providerOptions, {
		anthropic: { thinking: { type: "disabled" } },
	});
	for (const modelId of ["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
		const options = anthropic(modelId);
		assert.deepEqual(options.providerOptions, { anthropic: { effort: "low" } }, modelId);
		assert.equal(options.maxOutputTokens, 1_500, modelId);
		assert.equal(options.thinking, "on", modelId);
		assert.equal(options.effort, "low", modelId);
		assert.equal(options.thinkingRoom, 1_100, modelId);
	}
	const hinted = anthropic("claude-haiku-5-5", { reasoningEffort: "medium" });
	assert.deepEqual(hinted.providerOptions, { anthropic: { effort: "medium" } });
	assert.equal(hinted.maxOutputTokens, 1_500);
	const draft = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "draft",
		modelId: "claude-haiku-5-5",
	});
	assert.deepEqual(draft.providerOptions, { anthropic: { thinking: { type: "disabled" } } });
	assert.equal(draft.maxOutputTokens, 900);
});

test("Anthropic: a refused thinking or effort parameter is dropped once, with the thinking room", () => {
	const off = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "triage",
		modelId: "claude-haiku-5-5",
	});
	const plain = fallbackOptionsAfterError(off, apiError(400, "thinking: Extra inputs are not permitted"));
	assert.deepEqual(plain.providerOptions, { anthropic: {} });
	assert.equal(plain.thinking, "default");
	assert.equal(plain.maxOutputTokens, 1_500);
	assert.equal(fallbackOptionsAfterError(plain, apiError(400, "thinking is not supported")), null, "dropped once");
	// A saved effort the model refuses goes first; the request then switches thinking off instead.
	const hinted = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "triage",
		modelId: "claude-haiku-4-5",
		reasoningEffort: "high",
	});
	const next = fallbackOptionsAfterError(hinted, apiError(400, "effort is not supported for this model"));
	assert.equal(next.reasoningEffort, null);
	assert.deepEqual(next.providerOptions, { anthropic: { thinking: { type: "disabled" } } });
	assert.equal(next.maxOutputTokens, 400);
});

test("a request's own answer budget survives a parameter fallback, with the thinking room on top", () => {
	const line = buildModelCallOptions({
		provider: "compatible",
		kind: "draft",
		answerTokens: 80,
		reasoningEffort: "low",
	});
	assert.equal(line.maxOutputTokens, 1_180);
	assert.equal(line.thinkingRoom, 1_100);
	const dropped = fallbackOptionsAfterError(line, apiError(400, "Unrecognized reasoning_effort"));
	assert.equal(dropped.maxOutputTokens, 80, "not the draft kind's 900");
	assert.equal(dropped.answerTokens, 80);
	const anthropic = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "draft",
		modelId: "claude-haiku-5-5",
		answerTokens: 1_600,
	});
	assert.equal(anthropic.maxOutputTokens, 1_600);
	const plain = fallbackOptionsAfterError(anthropic, apiError(400, "thinking: not supported"));
	assert.equal(plain.maxOutputTokens, 2_700);
	assert.equal(buildModelCallOptions({ provider: "compatible", kind: "draft" }).maxOutputTokens, 900);
});

test("a cut-off answer is asked once more with double the budget and recorded with its budget", async () => {
	const caps = [];
	const attempt = await runTriageAttempt({
		prompt,
		options: buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: "low" }),
		generate: async (_request, options) => {
			caps.push([options.maxOutputTokens, options.retried ?? false]);
			return caps.length === 1
				? { text: "{", finishReason: "length", usage: { outputTokens: 1_500 } }
				: { text: validTriage, finishReason: "stop" };
		},
	});
	assert.equal(attempt.calls, 2);
	assert.equal(attempt.result.category, "fyi");
	assert.deepEqual(caps, [
		[1_500, false],
		[3_000, true],
	]);
	const error = await runTriageAttempt({
		prompt,
		options: buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: "low" }),
		generate: async (_request, options) => ({
			text: "{",
			finishReason: "length",
			usage: { outputTokens: options.maxOutputTokens, outputTokenDetails: { reasoningTokens: 2_900 } },
		}),
	}).catch((caught) => caught);
	assert.ok(error instanceof ModelOutputTruncatedError);
	assert.deepEqual(error.budget, {
		cap: 3_000,
		thinkingRoom: 2_200,
		extensionRoom: 0,
		thinking: "on",
		effort: "low",
		retried: true,
		used: 3_000,
		thinkingUsed: 2_900,
	});
});

test("a 400 mentioning reasoning drops the parameter and the reasoning budget", () => {
	const hinted = buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: "low" });
	const next = fallbackOptionsAfterError(
		hinted,
		apiError(400, "Bad Request", '{"error":"Unrecognized reasoning_effort"}'),
	);
	assert.equal(next.reasoningEffort, null);
	assert.equal(next.maxOutputTokens, 400);
	assert.deepEqual(next.providerOptions, { kite: { response_format: { type: "json_object" } } });
	assert.equal(fallbackOptionsAfterError(next, apiError(400, "reasoning not supported")), null, "dropped once");
	assert.equal(fallbackOptionsAfterError(hinted, apiError(500, "reasoning failed")), null);
	assert.equal(fallbackOptionsAfterError(hinted, apiError(400, "context too long")), null);
	assert.equal(
		fallbackOptionsAfterError(hinted, Object.assign(new Error("reasoning"), { status: 400 })).reasoningEffort,
		null,
	);
	assert.equal(fallbackOptionsAfterError(hinted, null), null);
	assert.equal(fallbackOptionsAfterError(hinted, "reasoning"), null);
	const noJson = fallbackOptionsAfterError(next, apiError(400, "response_format json_object is not supported"));
	assert.equal(noJson.jsonMode, false);
	assert.deepEqual(noJson.providerOptions, { kite: {} });
	assert.equal(fallbackOptionsAfterError(noJson, apiError(400, "response_format")), null);
});

test("callWithFallback retries once without a rejected parameter and rethrows other errors", async () => {
	const hinted = buildModelCallOptions({ provider: "compatible", kind: "triage", reasoningEffort: "minimal" });
	const seen = [];
	const result = await callWithFallback(hinted, async (options) => {
		seen.push(options.reasoningEffort);
		if (options.reasoningEffort) throw apiError(400, "reasoning_effort: none is not allowed");
		return "ok";
	});
	assert.equal(result, "ok");
	assert.deepEqual(seen, ["minimal", null]);
	let attempts = 0;
	await assert.rejects(
		callWithFallback(hinted, async () => {
			attempts += 1;
			throw apiError(500, "upstream");
		}),
		/upstream/,
	);
	assert.equal(attempts, 1);
});

test("a length finish is a failed attempt and is never parsed or repaired", async () => {
	assert.equal(completedText({ text: "x", finishReason: "stop" }), "x");
	assert.throws(() => completedText({ text: '{"category":', finishReason: "length" }), ModelOutputTruncatedError);
	const requests = [];
	await assert.rejects(
		runTriageAttempt({
			prompt,
			options: buildModelCallOptions({ provider: "compatible", kind: "triage" }),
			generate: async (request, options) => {
				requests.push([request, options.maxOutputTokens]);
				return { text: validTriage.slice(0, 20), finishReason: "length" };
			},
		}),
		(error) => error instanceof ModelOutputTruncatedError,
	);
	// One retry of the same request with double the budget, never a repair of the partial JSON.
	assert.deepEqual(
		requests.map(([request, cap]) => [request, cap]),
		[
			[prompt, 400],
			[prompt, 800],
		],
	);
});

test("runTriageAttempt parses a valid reply in one call", async () => {
	const options = buildModelCallOptions({ provider: "cloudflare", kind: "triage" });
	const seen = [];
	const attempt = await runTriageAttempt({
		prompt,
		options,
		generate: async (request, callOptions) => {
			seen.push([request, callOptions]);
			return { text: `\`\`\`json\n${validTriage}\n\`\`\``, finishReason: "stop" };
		},
	});
	assert.equal(attempt.calls, 1);
	assert.equal(attempt.result.category, "fyi");
	assert.equal(seen[0][0], prompt);
	assert.equal(seen[0][1], options);
	assert.ok(!("tools" in seen[0][0]) && !("tools" in seen[0][1]));
});

test("runTriageAttempt makes one repair call, then fails", async () => {
	const requests = [];
	const repaired = await runTriageAttempt({
		prompt,
		options: buildModelCallOptions({ provider: "compatible", kind: "triage" }),
		generate: async (request) => {
			requests.push(request);
			return { text: requests.length === 1 ? "not json" : validTriage, finishReason: "stop" };
		},
	});
	assert.equal(repaired.calls, 2);
	assert.ok(requests[1].messages.at(-1).content.startsWith(REPAIR_MARKER));
	assert.equal(requests[1].messages[0].content, "[[scenario:x]]", "the repair keeps the email so the scenario holds");

	let count = 0;
	await assert.rejects(
		runTriageAttempt({
			prompt,
			options: buildModelCallOptions({ provider: "compatible", kind: "triage" }),
			generate: async () => {
				count += 1;
				return { text: '{"category":"urgent","needsReply":true}', finishReason: "stop" };
			},
			now: new Date(),
		}),
		(error) => error instanceof TriageOutputError && /category/.test(error.message),
	);
	assert.equal(count, 2);
});

test("a length finish with complete JSON is still never parsed", async () => {
	let calls = 0;
	await assert.rejects(
		runTriageAttempt({
			prompt,
			options: buildModelCallOptions({ provider: "cloudflare", kind: "triage" }),
			generate: async () => {
				calls += 1;
				return { text: validTriage, finishReason: "length" };
			},
		}),
		(error) => error instanceof ModelOutputTruncatedError,
	);
	// The one retry at double the budget is cut off too; neither answer is parsed.
	assert.equal(calls, 2);
});

test("Workers AI drops JSON mode once after a 400 about json_schema", () => {
	const options = buildModelCallOptions({ provider: "cloudflare", kind: "triage" });
	const next = fallbackOptionsAfterError(options, apiError(400, "json_schema is required"));
	assert.equal(next.jsonMode, false);
	assert.deepEqual(next.providerOptions.workersAi, { chat_template_kwargs: { thinking: false } });
	assert.equal(fallbackOptionsAfterError(next, apiError(400, "json_schema is required")), null);
});

test("the triage model is the mailbox choice, else the cheapest priced model, else the chat model", () => {
	const models = ["big", "small", "unpriced"];
	const rates = {
		big: { input: 1, output: 4 },
		small: { input: 0.05, output: 0.3 },
		unpriced: { input: null, output: 1 },
	};
	const choose = (overrides) =>
		chooseTriageModelId({ triageModelId: null, mailboxModelId: null, models, rates, ...overrides });
	assert.equal(choose({ triageModelId: "big" }), "big");
	assert.equal(choose({ triageModelId: "gone" }), "small");
	assert.equal(choose({}), "small");
	assert.equal(choose({ rates: {}, mailboxModelId: "unpriced" }), "unpriced");
	assert.equal(choose({ rates: {}, mailboxModelId: "gone" }), null);
	assert.equal(choose({ rates: {} }), null);
});
