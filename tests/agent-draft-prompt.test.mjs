import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { DRAFT_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-draft-prompt-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [fileURLToPath(import.meta.resolve("../src/lib/agent/jobs/draft-prompt-utils.ts"))],
	outfile: join(outDir, "draft-prompt-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: "inline",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const { buildReplyDraftPrompt, isCleanDraftBody } = await import(
	pathToFileURL(join(outDir, "draft-prompt-utils.mjs")).href
);

test("the shared draft prompt keeps the legacy wording, window and meta-text check", () => {
	const at = new Date("2026-01-02T03:04:05.000Z");
	const prompt = buildReplyDraftPrompt("Be brief.", [
		{ direction: "inbound", createdAt: at, textBody: "Question?", htmlBody: null },
		{ direction: "outbound", createdAt: at, textBody: "", htmlBody: "<p>Answer</p>" },
		{ direction: "inbound", createdAt: at, textBody: "z".repeat(30_000), htmlBody: null },
	]);
	assert.ok(prompt.system.startsWith(`${DRAFT_SYSTEM_MARKER} Write one concise, helpful plain-text reply draft`));
	assert.ok(prompt.system.endsWith("Mailbox preferences: Be brief."));
	assert.ok(prompt.prompt.startsWith("Reply to the latest inbound email in this conversation:\n"));
	assert.match(prompt.prompt, /Mailbox \(2026-01-02T03:04:05\.000Z\): \s*Answer/);
	assert.ok(prompt.prompt.endsWith(`Sender (2026-01-02T03:04:05.000Z): ${"z".repeat(2_500)}`));
	const short = buildReplyDraftPrompt("x".repeat(5_000), [
		{ direction: "inbound", createdAt: at, textBody: "Hi", htmlBody: null },
	]);
	assert.ok(short.system.endsWith(`Mailbox preferences: ${"x".repeat(4_000)}`));
	const long = buildReplyDraftPrompt(
		"",
		Array.from({ length: 15 }, () => ({
			direction: "inbound",
			createdAt: at,
			textBody: "w".repeat(3_000),
			htmlBody: null,
		})),
	);
	assert.equal(long.prompt.length, "Reply to the latest inbound email in this conversation:\n".length + 24_000);
	assert.equal(isCleanDraftBody("Thanks, see you Friday."), true);
	assert.equal(isCleanDraftBody(""), false);
	assert.equal(isCleanDraftBody("Here is a draft: hello"), false);
	assert.equal(isCleanDraftBody("a".repeat(40_001)), false);
});
