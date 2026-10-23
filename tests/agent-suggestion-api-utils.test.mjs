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
const {
	parseStatusFilter,
	acceptRefusal,
	dismissRefusal,
	toApiSuggestion,
	canReviewDraft,
	reviewRefusal,
	countByKind,
	sumTotals,
	dismissSuggestionSchema,
} = await load("apiUtils");
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
	const phishing = { kind: "phishing", status: "open" };
	assert.equal(dismissRefusal(phishing), null);
	assert.equal(dismissRefusal({ ...phishing, status: "dismissed" }), null);
	assert.equal(dismissRefusal({ ...phishing, status: "accepted" }).status, 409);
	assert.equal(dismissRefusal(phishing, { notPhishing: true }), null);
	assert.equal(dismissRefusal({ kind: "reply", status: "open" }, { notPhishing: true }).status, 400);
	assert.equal(dismissRefusal({ kind: "reply", status: "open" }, { notPhishing: false }), null);
	assert.equal(dismissSuggestionSchema.safeParse({ notPhishing: true }).success, true);
	assert.equal(dismissSuggestionSchema.safeParse({ notPhishing: "yes" }).success, false);
	assert.equal(dismissSuggestionSchema.safeParse({ trustSender: true }).success, false);

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
	assert.notEqual(
		applyMutedSenderChange(full, "new@x.test", "add", "trustedSenders"),
		null,
		"each list has its own limit",
	);
});

test("trusted senders change in their own list and keep the muted list as stored", () => {
	const stored = '{"mutedSenders":["m@x.test"]}';
	const trusted = applyMutedSenderChange(stored, " Bank@X.test ", "add", "trustedSenders");
	assert.equal(trusted, '{"mutedSenders":["m@x.test"],"trustedSenders":["bank@x.test"]}');
	assert.equal(applyMutedSenderChange(trusted, "bank@x.test", "add", "trustedSenders"), null);
	assert.equal(applyMutedSenderChange(trusted, "m@x.test", "remove", "trustedSenders"), null);
	assert.equal(
		applyMutedSenderChange(trusted, "bank@x.test", "remove", "trustedSenders"),
		'{"mutedSenders":["m@x.test"],"trustedSenders":[]}',
	);
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
		draftUserId: null,
		draftStatus: null,
	};
	assert.deepEqual(toApiSuggestion(base, "u1"), {
		id: "s1",
		mailboxId: "m1",
		messageId: "msg1",
		threadId: null,
		kind: "summary",
		status: "open",
		title: "Summary",
		payload: { text: "Hi" },
		draftId: null,
		canReviewDraft: false,
		model: "fake",
		createdAt: "2026-10-01T10:00:00.000Z",
		decidedAt: null,
		expiresAt: null,
		message: { subject: "Hello", from: "a@b.test" },
	});
	const decided = toApiSuggestion({ ...base, payload: "[1]", decidedAt: created, expiresAt: created }, "u1");
	assert.deepEqual(decided.payload, {});
	assert.equal(decided.decidedAt, "2026-10-01T10:00:00.000Z");
	assert.equal(decided.expiresAt, "2026-10-01T10:00:00.000Z");
});

test("only the draft's owner may review it; everyone else may not, and a gone draft is reported", () => {
	const draft = { draftId: "d", draftUserId: "reviewer", draftStatus: "draft" };
	assert.equal(canReviewDraft(draft, "reviewer"), true);
	assert.equal(canReviewDraft(draft, "sharer"), false);
	assert.equal(canReviewDraft({ ...draft, draftStatus: "sent" }, "reviewer"), false);
	assert.equal(canReviewDraft({ draftId: null, draftUserId: null, draftStatus: null }, "reviewer"), false);
	assert.equal(reviewRefusal(draft, "reviewer"), null);
	assert.deepEqual(reviewRefusal(draft, "sharer"), { status: 403, error: "This draft is in the reviewer's Drafts" });
	assert.equal(reviewRefusal(undefined, "reviewer").status, 409);
	assert.equal(reviewRefusal({ ...draft, draftStatus: "trash" }, "reviewer").status, 409);
});

test("totals per kind add up to the overall total", () => {
	const totals = countByKind([{ kind: "reply" }, { kind: "summary" }, { kind: "reply" }]);
	assert.deepEqual(totals, { reply: 2, summary: 1 });
	assert.equal(sumTotals(totals), 3);
	assert.equal(sumTotals({}), 0);
});
