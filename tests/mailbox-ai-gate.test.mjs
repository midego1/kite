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
	if (!statSync(absolute).isDirectory()) return /\.(ts|tsx|mjs)$/.test(path) ? [path] : [];
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
	"src/lib/agent/summaries/service.ts": "selects",
	"src/lib/agent/summaries/line-job.ts": "selects",
	"src/lib/agent/auto-read/triage-model.ts": ["src/lib/agent/auto-read/triage-run.ts"],
	"src/lib/agent/jobs/draft-generation.ts": [
		"src/lib/agent/jobs/utils.ts",
		"src/lib/agent/auto-read/reply-suggestion.ts",
	],
};

test("only the model selection makes a provider client", () => {
	const constructors =
		/from "(@ai-sdk\/(?!provider")[^"]+|workers-ai-provider)"|\b(createOpenAICompatible|createAnthropic|createWorkersAI|createOpenAI)\(/;
	const offenders = files.filter((file) => file !== MODEL_FILE && constructors.test(read(file)));
	assert.deepEqual(offenders, [], "make provider clients only in getAgentModel");
	// The Workers AI binding is only ever wrapped there, never run directly.
	assert.deepEqual(
		files.filter((file) => /\.AI\.run\(/.test(read(file))),
		[],
	);
});

test("getAgentModel checks the mailbox's switch before anything else and needs a mailbox", () => {
	const source = read(MODEL_FILE);
	const body = source.slice(source.indexOf("export async function getAgentModel("));
	assert.match(body, /^export async function getAgentModel\(env: CloudflareEnv, request: AgentModelRequest\) \{/);
	assert.match(body.split("\n")[1], /^\tawait assertMailboxAiAllowed\(env, request\.mailboxId\);$/);
	assert.match(source, /export type AgentModelRequest = \{ mailboxId: string;/);
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
