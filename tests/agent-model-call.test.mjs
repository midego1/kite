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
			generate: async (request) => {
				requests.push(request);
				return { text: validTriage.slice(0, 20), finishReason: "length" };
			},
		}),
		(error) => error instanceof ModelOutputTruncatedError,
	);
	assert.equal(requests.length, 1, "no repair request after a length finish");
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
