import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Requests a person waits for (Write with Kite, summaries, chat) against a fake Anthropic Messages API that stops
// at max_tokens: Write with Kite on a long thread used to be cut off at 900 tokens and never asked again.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-interactive-cut-off-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(path));
await build({
	stdin: {
		contents: [
			`export * from ${JSON.stringify(source("../src/lib/agent/auto-read/model-call-utils.ts"))};`,
			`export * from ${JSON.stringify(source("../src/lib/agent/output-budget-utils.ts"))};`,
			`export { composeMaxOutputTokens } from ${JSON.stringify(source("../src/lib/agent/compose-prompt-utils.ts"))};`,
			`export { classifyAiError, readAiErrorBody } from ${JSON.stringify(source("../src/lib/agent/ai-error-utils.ts"))};`,
			`export { cutOffFacts, explainCutOff } from ${JSON.stringify(source("../src/lib/agent/cut-off-utils.ts"))};`,
		].join("\n"),
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "interactive-cut-off.mjs"),
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
const kite = await import(pathToFileURL(join(outDir, "interactive-cut-off.mjs")).href);
const {
	buildModelCallOptions,
	callWithCutOffRetry,
	chatStepOptions,
	classifyAiError,
	completedText,
	composeMaxOutputTokens,
	cutOffFacts,
	explainCutOff,
	INTERACTIVE_THINKING_ROOM_TOKENS,
	ModelOutputTruncatedError,
	readAiErrorBody,
} = kite;

const prompt = { system: "s", messages: [{ role: "user", content: "a long thread" }] };

/**
 * A fake Messages API whose answer takes `answer` output tokens, after `thinking(body)` tokens of thinking. Both count
 * against max_tokens; an answer that does not fit stops with stop_reason max_tokens, as Claude does.
 */
function fakeAnthropic({ answer, thinking = () => 0, refuse = () => null }) {
	const bodies = [];
	const fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		bodies.push(body);
		const refusal = refuse(body);
		if (refusal)
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: refusal } }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			);
		const thought = Math.min(thinking(body), body.max_tokens);
		const fits = thought + answer <= body.max_tokens;
		const output = fits ? thought + answer : body.max_tokens;
		const content = [
			...(thought ? [{ type: "thinking", thinking: "", signature: "sig" }] : []),
			...(thought < body.max_tokens ? [{ type: "text", text: fits ? "Following up on my email." : "Following" }] : []),
		];
		const reply = {
			id: `msg_${bodies.length}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content,
			stop_reason: fits ? "end_turn" : "max_tokens",
			stop_sequence: null,
			usage: { input_tokens: 9_000, output_tokens: output, output_tokens_details: { thinking_tokens: thought } },
		};
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	};
	const provider = createAnthropic({ apiKey: "test-key", baseURL: "http://anthropic.test/v1", fetch });
	return { bodies, provider };
}

/** Write with Kite's options for a new email, as `createComposeStream` builds them. */
function writeOptions(modelId, extra = {}) {
	return buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "draft",
		modelId,
		answerTokens: composeMaxOutputTokens({ mode: "write" }),
		thinkingRoomTokens: INTERACTIVE_THINKING_ROOM_TOKENS,
		...extra,
	});
}

/** One request through the shared helper, each attempt "reserved" with its own cap like the real callers. */
async function ask(fake, modelId, options) {
	const reserved = [];
	const cutOff = [];
	const { result, sent } = await callWithCutOffRetry(
		options,
		(current) => {
			reserved.push(current.maxOutputTokens);
			return generateText({
				model: fake.provider(modelId),
				...prompt,
				maxOutputTokens: current.maxOutputTokens,
				providerOptions: current.providerOptions,
				maxRetries: 0,
			});
		},
		async (first, options) => {
			cutOff.push([first.finishReason, options.maxOutputTokens]);
		},
	);
	return { result, sent, reserved, cutOff };
}

const isThinkingOn = (body) => body.thinking?.type !== "between_tools" && body.thinking?.type !== "disabled";

test("Write with Kite: the old 900-token cap cut off a follow-up on a long thread; 2,000 fits in one call", async () => {
	const fake = fakeAnthropic({ answer: 1_200 });
	const before = buildModelCallOptions({
		provider: "compatible",
		preset: "anthropic",
		kind: "draft",
		modelId: "claude-sonnet-5-5",
		answerTokens: 900,
	});
	const old = await generateText({
		model: fake.provider("claude-sonnet-5-5"),
		...prompt,
		maxOutputTokens: before.maxOutputTokens,
		providerOptions: before.providerOptions,
		maxRetries: 0,
	});
	assert.equal(old.finishReason, "length");

	const { result, sent, reserved, cutOff } = await ask(fake, "claude-sonnet-5-5", writeOptions("claude-sonnet-5-5"));
	assert.equal(completedText(result, sent), "Following up on my email.");
	assert.deepEqual(reserved, [2_000]);
	assert.deepEqual(cutOff, []);
	// Claude Sonnet 5.5's lowest setting: no thinking before the answer, and no thinking room.
	assert.deepEqual(fake.bodies.at(-1).thinking, { type: "between_tools" });
	assert.equal(fake.bodies.at(-1).max_tokens, 2_000);
});

test("a cut-off answer is asked once more with double the budget, each attempt reserved on its own", async () => {
	const fake = fakeAnthropic({ answer: 2_500 });
	const { result, sent, reserved, cutOff } = await ask(fake, "claude-sonnet-5-5", writeOptions("claude-sonnet-5-5"));
	assert.equal(completedText(result, sent), "Following up on my email.");
	assert.deepEqual(reserved, [2_000, 4_000]);
	assert.deepEqual(cutOff, [["length", 2_000]], "the first attempt is reported before the retry");
	assert.deepEqual(
		fake.bodies.map((body) => [body.max_tokens, body.thinking?.type]),
		[
			[2_000, "between_tools"],
			[4_000, "between_tools"],
		],
	);
	assert.equal(sent.retried, true);
});

test("a second cut-off fails with the retry's budget, which Details and Why? show", async () => {
	const fake = fakeAnthropic({ answer: 5_000 });
	const { result, sent, reserved } = await ask(fake, "claude-sonnet-5-5", writeOptions("claude-sonnet-5-5"));
	assert.deepEqual(reserved, [2_000, 4_000], "asked once more, never twice");
	const error = (() => {
		try {
			completedText(result, sent);
		} catch (caught) {
			return caught;
		}
		return assert.fail("expected a cut-off");
	})();
	assert.ok(error instanceof ModelOutputTruncatedError);
	const failure = classifyAiError(error);
	assert.equal(failure.code, "cut_off");
	const budget = {
		cap: 4_000,
		thinkingRoom: 0,
		extensionRoom: 0,
		thinking: "between_tools",
		effort: null,
		retried: true,
		used: 4_000,
		thinkingUsed: 0,
	};
	assert.deepEqual(failure.budget, budget);
	// The budget travels in the error body's details and is read back by the client.
	const body = readAiErrorBody({
		error: "The AI's answer was cut off before it was finished.",
		code: "cut_off",
		details: { code: "cut_off", feature: "compose", model: "claude-sonnet-5-5", provider: "anthropic", budget },
	});
	assert.deepEqual(body.details.budget, budget);
	assert.equal(readAiErrorBody({ ...body, details: { ...body.details, budget: "x" } }).details.budget, undefined);
	const input = {
		provider: "Anthropic",
		providerId: "anthropic",
		model: "claude-sonnet-5-5",
		feature: "compose",
		budget,
	};
	assert.deepEqual(cutOffFacts(input), [
		{ label: "Output cap", value: "4,000 tokens" },
		{ label: "Thinking", value: "at its lowest setting (between_tools: none before the answer)" },
		{ label: "Used", value: "4,000 output tokens" },
		{ label: "Retry", value: "cut off again at double the cap" },
	]);
	const { cause, fix } = explainCutOff(input);
	assert.match(cause, /^Write with Kite capped claude-sonnet-5-5's answer at 4,000 tokens/);
	assert.match(fix, /answer itself ran long, even at double the cap\. Choose another model in Admin → Agent\.$/);
});

test("a model that always thinks gets effort low and room for a long thread's thinking", async () => {
	// Claude Opus 5.5 cannot stop thinking; at effort low it still thinks about a long thread.
	const fake = fakeAnthropic({ answer: 1_200, thinking: (body) => (isThinkingOn(body) ? 2_500 : 0) });
	const options = writeOptions("claude-opus-5-5");
	assert.equal(options.maxOutputTokens, 5_000);
	assert.equal(options.thinkingRoom, 3_000);
	const { result, sent, reserved } = await ask(fake, "claude-opus-5-5", options);
	assert.equal(completedText(result, sent), "Following up on my email.");
	assert.deepEqual(reserved, [5_000]);
	assert.equal(fake.bodies[0].output_config?.effort, "low");
	assert.equal(fake.bodies[0].thinking, undefined);
	// A saved effort is sent as is, with the same room; the retry keeps the room and doubles both parts.
	const hinted = writeOptions("claude-haiku-5-5", { reasoningEffort: "high" });
	assert.deepEqual(hinted.providerOptions, { anthropic: { effort: "high" } });
	assert.equal(hinted.maxOutputTokens, 5_000);
	const thinking = fakeAnthropic({ answer: 1_200, thinking: (body) => (isThinkingOn(body) ? 4_500 : 0) });
	const widened = await ask(thinking, "claude-haiku-5-5", hinted);
	assert.equal(completedText(widened.result, widened.sent), "Following up on my email.");
	assert.deepEqual(widened.reserved, [5_000, 10_000]);
	assert.equal(widened.sent.thinkingRoom, 6_000);
});

test("the retry keeps a parameter fallback, and a refused attempt is never asked again", async () => {
	const fake = fakeAnthropic({
		answer: 2_500,
		refuse: (body) => (body.output_config?.effort === "xhigh" ? "effort: xhigh is not supported" : null),
	});
	const options = writeOptions("claude-haiku-5-5", { reasoningEffort: "xhigh" });
	const { result, sent, reserved } = await ask(fake, "claude-haiku-5-5", options);
	assert.equal(completedText(result, sent), "Following up on my email.");
	// Refused with the effort, then sent with thinking off: cut off at 2,000, asked again at 4,000 without the effort.
	assert.deepEqual(reserved, [5_000, 2_000, 4_000]);
	assert.deepEqual(
		fake.bodies.map((body) => [body.max_tokens, body.output_config?.effort ?? null, body.thinking?.type ?? null]),
		[
			[5_000, "xhigh", null],
			[2_000, null, "disabled"],
			[4_000, null, "disabled"],
		],
	);
	let calls = 0;
	const refused = await callWithCutOffRetry(options, async () => {
		calls += 1;
		return null;
	});
	assert.equal(refused.result, null);
	assert.equal(calls, 1);
});

test("chat and the assistant by email: the model keeps its thinking, the step cap makes room for it", () => {
	const anthropic = (modelId, reasoningEffort) =>
		chatStepOptions({ providerKind: "compatible", preset: "anthropic", modelId, reasoningEffort });
	for (const modelId of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-next-9"]) {
		const options = anthropic(modelId);
		assert.deepEqual(options.providerOptions, { anthropic: {} }, modelId);
		assert.equal(options.maxOutputTokens, 4_200, modelId);
		assert.equal(options.thinking, "default", modelId);
		assert.equal(options.thinkingRoom, 3_000, modelId);
	}
	// A model that does not think without being asked keeps the old cap.
	const claude4 = anthropic("claude-haiku-4-5");
	assert.deepEqual(claude4.providerOptions, { anthropic: {} });
	assert.equal(claude4.maxOutputTokens, 1_200);
	// A saved effort is sent as is; minimal is as little thinking as the model allows.
	assert.deepEqual(anthropic("claude-sonnet-5-5", "low").providerOptions, { anthropic: { effort: "low" } });
	assert.equal(anthropic("claude-sonnet-5-5", "low").maxOutputTokens, 4_200);
	assert.deepEqual(anthropic("claude-sonnet-5-5", "minimal").providerOptions, {
		anthropic: { thinking: { type: "between_tools" } },
	});
	assert.equal(anthropic("claude-sonnet-5-5", "minimal").maxOutputTokens, 1_200);
	const compatible = chatStepOptions({ providerKind: "compatible", preset: "openai", modelId: "gpt-x" });
	assert.deepEqual(compatible.providerOptions, { kite: {} });
	assert.equal(compatible.maxOutputTokens, 4_200);
	assert.deepEqual(
		chatStepOptions({ providerKind: "compatible", preset: "openai", modelId: "gpt-x", reasoningEffort: "low" })
			.providerOptions,
		{ kite: { reasoningEffort: "low" } },
	);
	// Workers AI chat is sent as before.
	const workers = chatStepOptions({ providerKind: "cloudflare", modelId: "@cf/x" });
	assert.deepEqual(workers.providerOptions, {});
	assert.equal(workers.maxOutputTokens, 1_200);
});
