import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// "No AI for this mailbox" is enforced where a model is chosen: `getAgentModel` (src/lib/agent/model.ts) checks the
// gate before it makes a provider client, and it is the only place one is made. These scans fail when a new path
// could reach a provider without that check.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["src", "server", "worker.ts", "worker-utils.ts"];
const MODEL_FILE = "src/lib/agent/model.ts";

function sourceFiles(path) {
	const absolute = join(root, path);
	if (!statSync(absolute).isDirectory()) return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path) ? [path] : [];
	return readdirSync(absolute).flatMap((name) => sourceFiles(join(path, name)));
}

const files = SOURCE_ROOTS.flatMap(sourceFiles).map((file) => file.split(sep).join("/"));
const read = (file) => readFileSync(join(root, file), "utf8");

/** Calls that send a prompt to a model through the AI SDK. */
const MODEL_CALL = /\b(generateText|streamText|generateObject|streamObject|embed|embedMany)\(/;
/** The selectors that pass the gate: each ends in `getAgentModel`. */
const GATED_SELECTOR = /\b(getAgentModel|selectInteractiveModel|selectAutoReadModel)\(/;

/**
 * Every file that calls a model, and where its model comes from. A file that only receives a `LanguageModel` names
 * the files that pass it one; each of those must select it through the gate.
 */
const MODEL_CALL_SITES = {
	"src/lib/agent/chat.ts": "selects",
	"src/lib/agent/compose.ts": "selects",
	"src/lib/agent/summaries/model-answer.ts": "selects",
	"src/lib/agent/summaries/line-job.ts": "selects",
	"src/lib/agent/auto-read/triage-model.ts": ["src/lib/agent/auto-read/triage-run.ts"],
	"src/lib/agent/jobs/draft-generation.ts": [
		"src/lib/agent/jobs/utils.ts",
		"src/lib/agent/auto-read/reply-suggestion.ts",
	],
};

/** The files that may import the AI SDK (`ai`, `ai/...`): types, usage accounting and the gated call sites. */
const AI_SDK_IMPORTERS = [
	"src/lib/agent/ai-errors.ts",
	"src/lib/agent/auto-read/model-call-utils.ts",
	"src/lib/agent/auto-read/spend-types.d.ts",
	"src/lib/agent/auto-read/spend-utils.ts",
	"src/lib/agent/auto-read/spend.ts",
	"src/lib/agent/auto-read/triage-model.ts",
	"src/lib/agent/chat-spend.ts",
	"src/lib/agent/chat-tools.ts",
	"src/lib/agent/chat.ts",
	"src/lib/agent/compose.ts",
	"src/lib/agent/jobs/draft-generation.ts",
	"src/lib/agent/jobs/utils.ts",
	MODEL_FILE,
	"src/lib/agent/pricing.ts",
	"src/lib/agent/summaries/line-job.ts",
	"src/lib/agent/summaries/model-answer.ts",
	"src/lib/ai/usage-types.d.ts",
	// Only for the shared `LanguageModelUsage` shape, to settle an embedding spend reservation through the same
	// `reconcileAiSpend` every other source uses; it never selects or calls a model.
	"src/lib/semantic/spend.ts",
];

/** `from "x"`, `import("x")`, `require("x")` and `export ... from "x"`, whatever the binding is called. */
const imports = (source) =>
	[...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);

test("only the model selection makes a provider client", () => {
	const providerPackage = (name) =>
		(name.startsWith("@ai-sdk/") && name !== "@ai-sdk/provider") || name.startsWith("workers-ai-provider");
	const constructors = /\b(createOpenAICompatible|createAnthropic|createWorkersAI|createOpenAI|createGateway)\(/;
	const offenders = files.filter(
		(file) => file !== MODEL_FILE && (imports(read(file)).some(providerPackage) || constructors.test(read(file))),
	);
	assert.deepEqual(offenders, [], "make provider clients only in getAgentModel");
	// A provider's raw call methods are only ever wrapped there.
	assert.deepEqual(
		files.filter((file) => file !== MODEL_FILE && /\b(doGenerate|doStream)\b/.test(read(file))),
		[],
	);
});

test("only the listed files import the AI SDK, under any name", () => {
	const importers = files.filter((file) => imports(read(file)).some((name) => name === "ai" || name.startsWith("ai/")));
	assert.deepEqual(importers.sort(), [...AI_SDK_IMPORTERS].sort(), "a new AI SDK importer: review it and list it here");
});

// Search by meaning (docs/specs/semantic-search.md) embeds mail text with Workers AI, never through a `LanguageModel`
// (it is not chat, so `getAgentModel` does not apply): `embedding.ts` is its own model-selection file, gated instead
// by the mailbox and install checks in `indexer.ts`/`backfill.ts` (never an AI-off mailbox, never enqueued for one)
// and the external-provider opt-in (`resolvedEmbeddingProviderKind` plus `externalProviderRefused`) before a
// compatible endpoint is ever asked to embed anything.
const MODEL_SELECTION_FILES = [MODEL_FILE, "src/lib/semantic/embedding.ts"];

test("the Workers AI binding is only checked for presence outside the model selection", () => {
	const use = /\.AI\b|\[\s*["'`]AI["'`]\s*\]|\{[^}]*\bAI\b[^}]*\}\s*=\s*env\b/;
	const presence = /!!?env\.AI\b(?!\.)|if \(env\.AI\)/;
	const offenders = files.flatMap((file) =>
		MODEL_SELECTION_FILES.includes(file)
			? []
			: read(file)
					.split("\n")
					.map((line, index) => ({ line, at: `${file}:${index + 1}` }))
					.filter(({ line }) => use.test(line) && !presence.test(line))
					.map(({ at }) => at),
	);
	assert.deepEqual(offenders, []);
});

test("getAgentModel checks the mailbox's switch before anything else, and every model it returns checks it again", () => {
	const source = read(MODEL_FILE);
	const body = source.slice(source.indexOf("export async function getAgentModel("));
	assert.match(body, /^export async function getAgentModel\(env: CloudflareEnv, request: AgentModelRequest\) \{/);
	const [, first, second] = body.split("\n");
	assert.equal(first, "\tconst { mailboxId, modelId: requestedModel } = request;");
	assert.equal(second, "\tawait assertMailboxAiAllowed(env, mailboxId);");
	assert.match(source, /export type AgentModelRequest = \{ mailboxId: string;/);
	// Every provider model is returned wrapped, so each call it makes (fallbacks, repairs, chat steps) checks again.
	const returned = [...body.matchAll(/\bmodel: ([a-zA-Z]+)\(/g)].map((match) => match[1]);
	assert.ok(returned.length >= 3);
	assert.deepEqual([...new Set(returned)], ["gated"]);
	const gated = source.slice(source.indexOf("function gated("), source.indexOf("export async function getAgentModel("));
	assert.equal(gated.match(/await assertMailboxAiAllowed\(env, mailboxId\);/g)?.length, 2);
});

test("every model call gets its model through the gate", () => {
	const calling = files.filter((file) => MODEL_CALL.test(read(file)));
	assert.deepEqual(
		calling.sort(),
		Object.keys(MODEL_CALL_SITES).sort(),
		"a new model call site: select its model with getAgentModel, selectInteractiveModel or selectAutoReadModel and list it here",
	);
	for (const [file, source] of Object.entries(MODEL_CALL_SITES)) {
		const selecting = source === "selects" ? [file] : source;
		for (const selector of selecting)
			assert.match(read(selector), GATED_SELECTOR, `${selector} must select the model ${relative(".", file)} uses`);
	}
});

test("the selectors pass the mailbox of the mail they send, never a bare model id", () => {
	for (const file of files) {
		const source = read(file);
		for (const match of source.matchAll(/\b(getAgentModel|selectInteractiveModel|selectAutoReadModel)\(([^)]*)/g)) {
			if (/^export async function/.test(source.slice(source.lastIndexOf("\n", match.index) + 1, match.index + 1)))
				continue;
			const args = match[2];
			// A call's second argument is the request object; its mailbox must be named.
			assert.match(args, /,\s*\{\s*(\n\s*)?mailboxId:|,\s*request\b/, `${file}: ${match[0]}`);
		}
	}
});
