import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonSchema, streamText } from "ai";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-workers-ai-stream-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { withDedupedStreams } from "./src/lib/agent/workers-ai-stream-utils.ts";
			export { getAgentModel } from "./src/lib/agent/model.ts";
		`,
		resolveDir: root,
		sourcefile: "workers-ai-stream-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { withDedupedStreams, getAgentModel } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

/** A D1 stand-in with no rows, so the provider config falls back to Workers AI and its default model. */
const emptyDb = {
	prepare() {
		const statement = {
			bind: () => statement,
			all: async () => ({ results: [] }),
			raw: async () => [],
			first: async () => null,
			run: async () => ({ success: true, meta: {} }),
		};
		return statement;
	},
	batch: async () => [],
};

function sseStream(events, { split } = {}) {
	const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	const bytes = new TextEncoder().encode(payload);
	return new ReadableStream({
		start(controller) {
			if (split) {
				controller.enqueue(bytes.subarray(0, split));
				controller.enqueue(bytes.subarray(split));
			} else controller.enqueue(bytes);
			controller.close();
		},
	});
}

/** What a binding wrapped by `withDedupedStreams` streams for a raw stream of the given chunks. */
async function deduped(...chunks) {
	const wrapped = withDedupedStreams({
		run: async () =>
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
	});
	return new Response(await wrapped.run()).text();
}

async function streamedText(events, options) {
	const agent = await getAgentModel({ DB: emptyDb, AI: { run: async () => sseStream(events, options) } });
	assert.ok(agent?.model);
	return streamText({ model: agent.model, prompt: "Say OK" }).text;
}

test("an event carrying both formats yields its text once", async () => {
	const text = await streamedText([
		{ response: "OK", choices: [{ index: 0, delta: { content: "OK" } }] },
		{ response: ".", choices: [{ index: 0, delta: { content: "." }, finish_reason: "stop" }] },
	]);
	assert.equal(text, "OK.");
});

test("native-only and OpenAI-only streams are unchanged", async () => {
	assert.equal(await streamedText([{ response: "OK" }, { response: ".", finish_reason: "stop" }]), "OK.");
	assert.equal(
		await streamedText([
			{ choices: [{ index: 0, delta: { content: "OK" } }] },
			{ choices: [{ index: 0, delta: { content: "." }, finish_reason: "stop" }] },
		]),
		"OK.",
	);
});

test("text repeated across events is kept, and an event split across chunks is handled", async () => {
	const repeated = [
		{ response: "ha", choices: [{ index: 0, delta: { content: "ha" } }] },
		{ response: "ha", choices: [{ index: 0, delta: { content: "ha" }, finish_reason: "stop" }] },
	];
	assert.equal(await streamedText(repeated), "haha");
	assert.equal(await streamedText(repeated, { split: 12 }), "haha");
});

test("a tool call sent in both formats is called once", async () => {
	const toolCall = [
		{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"city":"Utrecht"}' } },
	];
	const agent = await getAgentModel({
		DB: emptyDb,
		AI: {
			run: async () => sseStream([{ tool_calls: toolCall, choices: [{ index: 0, delta: { tool_calls: toolCall } }] }]),
		},
	});
	const result = streamText({
		model: agent.model,
		prompt: "Look up Utrecht",
		tools: {
			lookup: {
				description: "Look up a city",
				inputSchema: jsonSchema({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
			},
		},
	});
	const calls = await result.toolCalls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].toolName, "lookup");
	assert.deepEqual(calls[0].input, { city: "Utrecht" });
});

test("only JSON data lines that carry a delta are changed", async () => {
	assert.equal(await deduped("data: [DONE]"), "data: [DONE]");
	assert.equal(await deduped(""), "");
	assert.equal(await deduped("event: ping"), "event: ping");
	assert.equal(await deduped("data: {broken"), "data: {broken");
	assert.equal(await deduped('data: {"response":"OK"}'), 'data: {"response":"OK"}');
	const emptyDelta = 'data: {"response":"OK","choices":[{"delta":{}}]}';
	assert.equal(await deduped(emptyDelta), emptyDelta);
	assert.equal(
		await deduped('data:{"response":"OK","choices":[{"delta":{"content":"OK"}}]}\r'),
		'data:{"choices":[{"delta":{"content":"OK"}}]}\r',
	);
	assert.equal(
		await deduped('data: {"tool_calls":[{"id":"a"}],"choices":[{"delta":{"tool_calls":[{"id":"a"}]}}]}'),
		'data: {"choices":[{"delta":{"tool_calls":[{"id":"a"}]}}]}',
	);
});

test("withDedupedStreams leaves non-stream results and other binding members alone", async () => {
	const binding = {
		label: "ai",
		gateway(id) {
			return `${this.label}:${id}`;
		},
		async run() {
			return { response: "OK" };
		},
	};
	const wrapped = withDedupedStreams(binding);
	assert.deepEqual(await wrapped.run("model", {}), { response: "OK" });
	assert.equal(wrapped.label, "ai");
	assert.equal(wrapped.gateway("main"), "ai:main");
	const text = await deduped('data: {"response":"A","choices":[{"delta":{"content":"A"}}]}\ndata: [DO', "NE]");
	assert.equal(text, 'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: [DONE]');
});
