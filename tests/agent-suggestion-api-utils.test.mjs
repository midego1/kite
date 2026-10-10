import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-suggestion-api-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// Inline source maps attribute coverage to the two pure modules; the lifecycle test bundles them without maps.
await build({
	entryPoints: {
		apiUtils: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/suggestion-api-utils.ts")),
		muteUtils: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/muted-senders-utils.ts")),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	sourcemap: "inline",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { parseStatusFilter, acceptRefusal, dismissRefusal, toApiSuggestion } = await load("apiUtils");
const { applyMutedSenderChange } = await load("muteUtils");

test("status filters, accept refusals and muted sender changes", () => {
	assert.equal(parseStatusFilter(null, true), "all");
	assert.equal(parseStatusFilter("", false), "open");
	assert.equal(parseStatusFilter("all", false), "all");
	assert.equal(parseStatusFilter("superseded", true), "superseded");
	assert.equal(parseStatusFilter("bogus", true), null);

	const reply = { kind: "reply", status: "open", draftId: "d" };
	assert.equal(acceptRefusal(reply, "review"), null);
	assert.equal(acceptRefusal({ ...reply, status: "dismissed" }, "review").status, 409);
	assert.equal(acceptRefusal({ kind: "calendar_invite", status: "open", draftId: null }, "accept").status, 400);
	assert.equal(acceptRefusal({ kind: "phishing", status: "accepted", draftId: null }, "mark_spam"), null);
	assert.equal(acceptRefusal({ kind: "phishing", status: "expired", draftId: null }, "mark_spam").status, 409);
	assert.equal(dismissRefusal("open"), null);
	assert.equal(dismissRefusal("dismissed"), null);
	assert.equal(dismissRefusal("accepted").status, 409);

	assert.equal(
		applyMutedSenderChange('{"reply":false}', " Sam@Sender.test ", "add"),
		'{"reply":false,"mutedSenders":["sam@sender.test"]}',
	);
	assert.equal(applyMutedSenderChange('{"mutedSenders":["sam@sender.test"]}', "SAM@sender.test", "add"), null);
	assert.equal(applyMutedSenderChange("not json", "", "add"), null);
	assert.equal(applyMutedSenderChange(null, "a@b.test", "remove"), null);
	assert.equal(
		applyMutedSenderChange('{"mutedSenders":["a@b.test","c@d.test",3]}', "a@b.test", "remove"),
		'{"mutedSenders":["c@d.test"]}',
	);
	const full = JSON.stringify({ mutedSenders: Array.from({ length: 500 }, (_, index) => `s${index}@x.test`) });
	assert.equal(applyMutedSenderChange(full, "new@x.test", "add"), null);
});

test("toApiSuggestion parses the payload and formats dates", () => {
	const created = new Date("2026-10-01T10:00:00Z");
	const base = {
		id: "s1",
		mailboxId: "m1",
		messageId: "msg1",
		threadId: null,
		kind: "summary",
		status: "open",
		title: "Summary",
		payload: '{"text":"Hi"}',
		draftId: null,
		model: "fake",
		createdAt: created,
		decidedAt: null,
		expiresAt: null,
		subject: "Hello",
		from: "a@b.test",
	};
	assert.deepEqual(toApiSuggestion(base), {
		id: "s1",
		mailboxId: "m1",
		messageId: "msg1",
		threadId: null,
		kind: "summary",
		status: "open",
		title: "Summary",
		payload: { text: "Hi" },
		draftId: null,
		model: "fake",
		createdAt: "2026-10-01T10:00:00.000Z",
		decidedAt: null,
		expiresAt: null,
		message: { subject: "Hello", from: "a@b.test" },
	});
	const decided = toApiSuggestion({ ...base, payload: "[1]", decidedAt: created, expiresAt: created });
	assert.deepEqual(decided.payload, {});
	assert.equal(decided.decidedAt, "2026-10-01T10:00:00.000Z");
	assert.equal(decided.expiresAt, "2026-10-01T10:00:00.000Z");
});
