import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-ai-failure-report-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [fileURLToPath(import.meta.resolve("../src/lib/agent/ai-failure-report-utils.ts"))],
	outfile: join(bundleDirectory, "ai-failure-report-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const { aiFailurePrompt, aiProviderLabel, askAiState, blockingAiFailure, explainAiFailure, groupAiFailures } =
	await import(pathToFileURL(join(bundleDirectory, "ai-failure-report-utils.mjs")).href);

const row = (code, at, extra = {}) => ({
	code,
	at,
	feature: "auto_triage",
	model: "gpt-4o-mini",
	provider: "openai",
	status: null,
	...extra,
});

const ROWS = [
	row("timeout", "2026-10-31T08:00:00.000Z", { feature: "summary" }),
	row("provider_auth", "2026-10-31T09:00:00.000Z", { status: 401 }),
	row("provider_auth", "2026-10-31T11:30:00.000Z", { status: 401, feature: "summary" }),
	row("provider_auth", "2026-10-31T10:00:00.000Z", { status: 403 }),
	row("internal", "2026-10-31T12:00:00.000Z", { model: null, provider: null, feature: "chat" }),
];

test("failures group by code, most frequent first, with features, models, statuses and times", () => {
	const groups = groupAiFailures(ROWS);
	assert.deepEqual(
		groups.map((group) => [group.code, group.count]),
		// Equal counts: the newest group first.
		[
			["provider_auth", 3],
			["internal", 1],
			["timeout", 1],
		],
	);
	const [auth] = groups;
	assert.equal(auth.firstAt, "2026-10-31T09:00:00.000Z");
	assert.equal(auth.lastAt, "2026-10-31T11:30:00.000Z");
	assert.deepEqual(auth.features, [
		{ feature: "auto_triage", label: "Automatic reading", count: 2 },
		{ feature: "summary", label: "Summary", count: 1 },
	]);
	assert.deepEqual(auth.models, [{ provider: "openai", providerLabel: "OpenAI", model: "gpt-4o-mini", count: 3 }]);
	assert.deepEqual(auth.statuses, [401, 403]);
	// The newest failure's sentence and status, the provider named, a link to the provider settings.
	assert.equal(
		auth.latestMessage,
		"The AI provider did not accept Kite's API key (HTTP 401). Update the key in Admin → Agent.",
	);
	assert.match(auth.cause, /^OpenAI refused Kite's API key \(HTTP 401\)/);
	assert.match(auth.fix, /Admin → Agent/);
	assert.deepEqual(auth.link, { href: "/agent#ai-provider", label: "Open AI provider settings" });
	const internal = groups.find((group) => group.code === "internal");
	assert.deepEqual(internal.models, [{ provider: null, providerLabel: null, model: null, count: 1 }]);
	assert.equal(internal.link.href, "/agent#recent-ai-errors");
});

test("every code has a cause, a fix and a same-site link or none", () => {
	const codes = [
		"timeout",
		"cut_off",
		"provider_rejected",
		"provider_auth",
		"provider_unavailable",
		"provider_error",
		"provider_rate_limited",
		"model_unavailable",
		"context_too_long",
		"unusable_answer",
		"spend_cap",
		"rate_limited",
		"external_provider_not_allowed",
		"assistant_off",
		"no_provider",
		"provider_key_unreadable",
		"network",
		"internal",
	];
	for (const code of codes) {
		const { cause, fix, link } = explainAiFailure(code, { provider: "Groq", status: 500 });
		assert.ok(cause.length > 10 && fix.length > 10, code);
		if (link) assert.match(link.href, /^\/[a-z-]/, code);
	}
	// Without a provider the sentence still reads.
	assert.match(explainAiFailure("provider_unavailable").cause, /^The AI provider had a problem/);
	assert.equal(explainAiFailure("spend_cap").link.href, "/agent#automatic-reading");
	assert.equal(explainAiFailure("provider_rate_limited").link.href, "/ai-usage");
});

test("provider labels follow Admin → Agent", () => {
	assert.equal(aiProviderLabel("cloudflare"), "Cloudflare Workers AI");
	assert.equal(aiProviderLabel("anthropic"), "Anthropic");
	assert.equal(aiProviderLabel("custom"), "Custom endpoint");
	assert.equal(aiProviderLabel("compatible"), "External provider");
	assert.equal(aiProviderLabel(null), null);
});

test("only a broken key or the default model of the assistant's own provider blocks Ask AI", () => {
	const current = { provider: "openai", model: "gpt-4o-mini" };
	assert.equal(blockingAiFailure(ROWS, current).at, "2026-10-31T11:30:00.000Z");
	assert.equal(blockingAiFailure(ROWS, { provider: "anthropic", model: "claude" }), null);
	const timeouts = [
		row("timeout", "2026-10-31T10:00:00.000Z"),
		row("provider_unavailable", "2026-10-31T11:00:00.000Z"),
	];
	assert.equal(blockingAiFailure(timeouts, current), null);
	const otherModel = [row("model_unavailable", "2026-10-31T10:00:00.000Z", { model: "old-model" })];
	assert.equal(blockingAiFailure(otherModel, current), null);
	assert.equal(blockingAiFailure(otherModel, { provider: "openai", model: "old-model" }).code, "model_unavailable");
});

test("Ask AI runs only when the assistant could, and says why and where to fix it otherwise", () => {
	const ok = {
		enabled: true,
		configured: true,
		keyUnreadable: false,
		externalNotAllowed: false,
		blocking: null,
		providerLabel: "OpenAI",
	};
	assert.deepEqual(askAiState(ok), { available: true });
	const off = askAiState({ ...ok, enabled: false });
	assert.equal(off.available, false);
	assert.match(off.reason, /turned off/);
	assert.equal(off.link.href, "/agent");
	assert.match(askAiState({ ...ok, configured: false }).reason, /none is set up/);
	assert.match(askAiState({ ...ok, keyUnreadable: true }).reason, /can't be decrypted/);
	const optIn = askAiState({ ...ok, externalNotAllowed: true });
	assert.match(optIn.reason, /OpenAI is not allowed to read mail/);
	assert.equal(optIn.link.href, "/agent#automatic-reading");
	const failing = askAiState({ ...ok, blocking: ROWS[1] });
	assert.match(failing.reason, /would fail the same way.*OpenAI.*provider_auth/);
	assert.equal(failing.link.href, "/agent#ai-provider");
});

test("the Ask AI prompt has counts, codes and Kite's sentences, never people, mailboxes or content", () => {
	const groups = groupAiFailures(ROWS);
	const prompt = aiFailurePrompt(groups, ROWS.length, false);
	assert.match(prompt, /^Kite recorded 5 failed AI requests in the last 24 hours\./);
	assert.match(prompt, /1\. provider_auth: 3 times, 2026-10-31 09:00 UTC to 2026-10-31 11:30 UTC/);
	assert.match(prompt, /Features: Automatic reading \(2\), Summary \(1\)/);
	assert.match(prompt, /Provider and model: OpenAI · gpt-4o-mini \(3\)/);
	assert.match(prompt, /HTTP status: 401, 403/);
	assert.match(prompt, /no model chosen \(1\)/);
	assert.match(aiFailurePrompt(groups, 200, true), /^Kite recorded at least 200 failed/);
	assert.doesNotMatch(prompt, /@/);
	// Stays under the chat route's 4,000 characters however many failures there are.
	const many = Array.from({ length: 200 }, (_, index) =>
		row("provider_error", `2026-10-31T10:${String(index % 60).padStart(2, "0")}:00.000Z`, {
			model: `model-with-a-long-name-${index}`,
		}),
	);
	assert.ok(aiFailurePrompt(groupAiFailures(many), 200, true).length <= 3_500);
});

// Production on 2026-10-31: twelve automatic-reading requests to Anthropic's claude-haiku-5-5 cut off.
const haikuCutOff = (at, extra = {}) =>
	row("cut_off", at, { model: "claude-haiku-5-5", provider: "anthropic", ...extra });

test("Why? for a cut-off without a recorded budget names the feature's cap and the model's default thinking", () => {
	const rows = Array.from({ length: 12 }, (_, index) =>
		haikuCutOff(`2026-10-31T${String(index + 8).padStart(2, "0")}:00:00.000Z`),
	);
	const [group] = groupAiFailures(rows);
	assert.equal(group.code, "cut_off");
	assert.match(group.cause, /^Automatic reading caps the answer at 400 tokens for the answer, plus up to 200/);
	assert.match(group.cause, /claude-haiku-5-5 thinks before it answers unless the request switches thinking off/);
	assert.match(group.cause, /Thinking counts against the same cap/);
	assert.match(group.fix, /Kite now switches thinking off for claude-haiku-5-5/);
	assert.match(group.fix, /retries a cut-off answer once with double the cap/);
	assert.deepEqual(group.link, { href: "/agent#automatic-reading", label: "Open automatic reading settings" });
	assert.deepEqual(
		group.facts.map((fact) => fact.label),
		["Output cap", "Thinking"],
	);
	assert.match(group.facts[0].value, /not recorded for these failures/);
	assert.equal(group.facts[1].value, "claude-haiku-5-5 thinks by default");

	const prompt = aiFailurePrompt([group], 12, false);
	assert.match(prompt, /1\. cut_off: 12 times/);
	assert.match(prompt, /Provider and model: Anthropic · claude-haiku-5-5 \(12\)/);
	assert.match(prompt, /Kite facts: Output cap: 400 tokens for the answer, plus up to 200 for module extensions/);
	assert.match(prompt, /Thinking: claude-haiku-5-5 thinks by default/);
	assert.match(prompt, /Kite's diagnosis: Automatic reading caps the answer at 400 tokens/);
	assert.match(prompt, /Kite's fix: These failures were recorded by a Kite that left thinking on/);
	assert.match(prompt, /About Automatic reading: Automatic reading makes one request per incoming message/);
	assert.match(prompt, /Thinking tokens count against the cap/);
	assert.match(prompt, /name the Kite setting to change/);
	assert.ok(prompt.length <= 3_500);
});

test("Why? and Ask AI for a cut-off with a recorded budget state the cap, thinking, usage and the setting to change", () => {
	const budget = {
		cap: 3_120,
		thinkingRoom: 2_200,
		extensionRoom: 120,
		thinking: "on",
		effort: "medium",
		retried: true,
		used: 3_120,
		thinkingUsed: 3_050,
	};
	const [group] = groupAiFailures([
		haikuCutOff("2026-10-31T09:00:00.000Z"),
		haikuCutOff("2026-10-31T10:00:00.000Z", { budget }),
	]);
	assert.equal(
		group.cause,
		"Automatic reading capped claude-haiku-5-5's answer at 3,120 tokens (800 for the answer + 2,200 for thinking + 120 for module extensions), and the model used 3,120 output tokens, 3,050 of them thinking, and stopped before the answer was finished. Thinking was on at effort medium. Kite had already retried once with double the cap.",
	);
	assert.match(group.fix, /^Clear claude-haiku-5-5's reasoning effort, or set it to minimal/);
	assert.match(group.fix, /Without an effort, Kite switches thinking off\.$/);
	assert.deepEqual(group.facts, [
		{
			label: "Output cap",
			value: "3,120 tokens (800 for the answer + 2,200 for thinking + 120 for module extensions)",
		},
		{ label: "Thinking", value: "on at effort medium" },
		{ label: "Used", value: "3,120 output tokens, 3,050 of them thinking" },
		{ label: "Retry", value: "cut off again at double the cap" },
	]);
	const prompt = aiFailurePrompt([group], 2, false);
	assert.match(prompt, /Kite facts: Output cap: 3,120 tokens \(800 for the answer \+ 2,200 for thinking/);
	assert.match(prompt, /Thinking: on at effort medium; Used: 3,120 output tokens, 3,050 of them thinking/);
	assert.match(prompt, /Kite's fix: Clear claude-haiku-5-5's reasoning effort/);
	assert.doesNotMatch(prompt, /@/);

	// A model that always thinks cannot be helped by a lower effort: the fix names another model.
	const [opus] = groupAiFailures([
		row("cut_off", "2026-10-31T10:00:00.000Z", {
			model: "claude-opus-5-5",
			provider: "anthropic",
			budget: { ...budget, effort: "low" },
		}),
	]);
	assert.match(opus.fix, /claude-opus-5-5 always thinks, even at effort low/);
	// A provider that decides thinking itself, and an answer that ran long with thinking off.
	const [routed] = groupAiFailures([
		row("cut_off", "2026-10-31T10:00:00.000Z", {
			budget: { ...budget, thinking: "default", effort: null, thinkingRoom: 0 },
		}),
	]);
	assert.match(routed.fix, /^OpenAI decides whether gpt-4o-mini thinks/);
	const [long] = groupAiFailures([
		row("cut_off", "2026-10-31T10:00:00.000Z", { budget: { ...budget, thinking: "off", thinkingRoom: 0 } }),
	]);
	assert.match(long.fix, /^Thinking was already off, so the answer itself ran long, even at double the cap\./);
	assert.match(long.fix, /turn that module's automatic reading switch off/);
});

test("a quoted budget names the model, provider and feature of its own row, not the most common one", () => {
	const old = Array.from({ length: 12 }, (_, index) =>
		haikuCutOff(`2026-10-31T${String(index + 8).padStart(2, "0")}:00:00.000Z`),
	);
	const opus = row("cut_off", "2026-10-31T07:00:00.000Z", {
		model: "claude-opus-5-5",
		provider: "anthropic",
		feature: "line_summary",
		budget: {
			cap: 2_360,
			thinkingRoom: 2_200,
			extensionRoom: 0,
			thinking: "on",
			effort: "low",
			retried: true,
			used: 2_360,
			thinkingUsed: 2_300,
		},
	});
	const [group] = groupAiFailures([...old, opus]);
	assert.equal(group.count, 13);
	assert.deepEqual(group.models[0], {
		provider: "anthropic",
		providerLabel: "Anthropic",
		model: "claude-haiku-5-5",
		count: 12,
	});
	assert.match(group.cause, /^One-line summary capped claude-opus-5-5's answer at 2,360 tokens/);
	assert.doesNotMatch(group.cause, /haiku/);
	assert.match(group.fix, /^claude-opus-5-5 always thinks, even at effort low/);
	assert.deepEqual(group.link, { href: "/agent#ai-provider", label: "Open AI provider settings" });
	assert.equal(group.facts[1].value, "on at effort low");
	// Sonnet 5.5's lowest setting is reported as such, never as "off".
	const [sonnet] = groupAiFailures([
		row("cut_off", "2026-10-31T07:00:00.000Z", {
			model: "claude-sonnet-5-5",
			provider: "anthropic",
			budget: { ...opus.budget, thinking: "between_tools", effort: null, thinkingRoom: 0, cap: 400, used: 400 },
		}),
	]);
	assert.match(sonnet.cause, /Thinking was at its lowest setting \(between_tools: none before the answer\)\./);
	assert.match(sonnet.fix, /^Thinking was already at its lowest setting, so the answer itself ran long/);
});

test("Ask AI keeps whole groups: one that does not fit is counted, never cut off mid-way", () => {
	const at = (hour) => `2026-10-31T${String(hour).padStart(2, "0")}:00:00.000Z`;
	const features = ["auto_triage", "auto_draft", "line_summary", "compose", "summary", "summary_translation"];
	const rows = [
		...features.flatMap((feature, index) => [
			haikuCutOff(at(8 + index), { feature }),
			haikuCutOff(at(8 + index), { feature }),
		]),
		row("provider_auth", at(15), { status: 401 }),
		row("timeout", at(16), { feature: "summary" }),
	];
	const groups = groupAiFailures(rows);
	assert.equal(groups[0].code, "cut_off");
	const prompt = aiFailurePrompt(groups, rows.length, false);
	assert.ok(prompt.length <= 3_500, String(prompt.length));
	assert.doesNotMatch(prompt, /…$/, "nothing is cut mid-way");
	assert.match(prompt, /1\. cut_off: 12 times/);
	for (const label of ["Automatic reading", "Agent draft", "One-line summary", "Write with Kite"])
		assert.match(prompt, new RegExp(`About ${label}: `));
	// Every group that is in the prompt is complete, and the rest are counted.
	const kept = [...prompt.matchAll(/^\d+\. (\w+):/gm)].map((match) => match[1]);
	assert.ok(kept.length < groups.length, "some groups did not fit");
	for (const block of prompt.split(/\n\n(?=\d+\. )/).slice(1))
		assert.match(block.split("\n\nAnd ")[0], /Kite's fix: .+$/s);
	assert.match(prompt, new RegExp(`And ${groups.length - kept.length} more kinds? of failure\\.$`));
});

test("a saved effort on a model that always thinks is cleared, not blamed on the model", () => {
	const budget = {
		cap: 1_500,
		thinkingRoom: 1_100,
		extensionRoom: 0,
		thinking: "on",
		effort: "high",
		retried: false,
		used: 1_500,
		thinkingUsed: 1_480,
	};
	const [group] = groupAiFailures([
		row("cut_off", "2026-10-31T10:00:00.000Z", { model: "claude-opus-5-5", provider: "anthropic", budget }),
	]);
	assert.doesNotMatch(group.fix, /always thinks/);
	assert.match(group.fix, /^Clear claude-opus-5-5's reasoning effort, or set it to minimal/);
	assert.match(group.fix, /Without an effort, Kite sends effort low, the least this model allows\.$/);
});
