import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXED_NOW, input } from "./fixtures/agent-prompts/inputs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-prompts-unchanged-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		triage: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/triage-utils.ts")),
		draft: fileURLToPath(import.meta.resolve("../src/lib/agent/jobs/draft-prompt-utils.ts")),
		chat: fileURLToPath(import.meta.resolve("../src/lib/agent/system-prompt-utils.ts")),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { buildTriagePrompt } = await load("triage");
const { buildReplyDraftPrompt } = await load("draft");
const { agentSystemPrompt } = await load("chat");

// The prompts the code built for these inputs before the editable prompt fields and the shared block helpers.
const expected = JSON.parse(readFileSync(join(root, "tests/fixtures/agent-prompts/expected.json"), "utf8"));

const RealDate = Date;
const fixed = RealDate.parse(FIXED_NOW);

/** Runs `run` with the clock stopped at FIXED_NOW, since the chat prompt states the current time. */
function atFixedTime(run) {
	globalThis.Date = class extends RealDate {
		constructor(...args) {
			super(...(args.length ? args : [fixed]));
		}
		static now() {
			return fixed;
		}
	};
	try {
		return run();
	} finally {
		globalThis.Date = RealDate;
	}
}

const thread = (rows) => rows.map((row) => ({ ...row, createdAt: new RealDate(row.createdAt) }));
const noPreferences = { mailbox: { chat: "", draft: "" }, personal: null };
const emptyPersonal = { name: "Sam", general: "", chat: "", draft: "", summary: "  " };

test("the triage prompt is byte-for-byte the one built before the untrusted-block helpers moved", () => {
	input.triage.forEach((item, index) =>
		assert.deepEqual(buildTriagePrompt({ ...item, now: new RealDate(item.now) }), expected.triage[index]),
	);
});

test("with empty drafting and personal fields the reply draft prompt is unchanged", () => {
	input.draft.forEach((item, index) => {
		const rows = thread(item.thread);
		assert.deepEqual(buildReplyDraftPrompt(item.instructions, rows), expected.draft[index]);
		assert.deepEqual(
			buildReplyDraftPrompt(item.instructions, rows, { mailboxDraft: " ", personal: emptyPersonal }),
			expected.draft[index],
		);
	});
});

test("with empty chat, drafting and personal fields the chat system prompt is unchanged", () => {
	input.chat.forEach((item, index) => {
		const built = atFixedTime(() => [
			agentSystemPrompt(item.instructions, item.timeZone, item.fragments),
			agentSystemPrompt(item.instructions, item.timeZone, item.fragments, noPreferences),
			agentSystemPrompt(item.instructions, item.timeZone, item.fragments, {
				mailbox: { chat: "\n", draft: "" },
				personal: emptyPersonal,
			}),
		]);
		for (const prompt of built) assert.equal(prompt, expected.chat[index]);
	});
});
