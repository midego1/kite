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
