import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-model-prices-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const prices = await bundle("src/lib/agent/model-prices-utils.ts", "model-prices.mjs");
const pricing = await bundle("src/lib/agent/pricing.ts", "pricing.mjs");
const spend = await bundle("src/lib/agent/auto-read/spend-utils.ts", "spend.mjs");
const triage = await bundle("src/lib/agent/auto-read/model-call-utils.ts", "model-call.mjs");
const costRates = await bundle("src/app/(admin)/agent/cost-rates-utils.ts", "cost-rates.mjs");
const settingsUi = await bundle("src/components/agent/auto-read-settings-utils.ts", "settings-ui.mjs");

const list = JSON.parse(readFileSync(join(root, "src/lib/agent/model-prices.json"), "utf8"));
const NOW = new Date("2026-10-28T12:00:00Z");
const OFFICIAL_HOSTS = {
	anthropic: "platform.claude.com",
	openai: "platform.openai.com",
	google: "ai.google.dev",
	cloudflare: "developers.cloudflare.com",
	groq: "console.groq.com",
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000;

test("every price list entry has rates, an official https source and an as-of date that is not in the future", () => {
	assert.equal(list.version, 1);
	assert.ok(list.models.length > 0);
	const today = new Date().toISOString().slice(0, 10);
	const seen = new Set();
	for (const entry of list.models) {
		const label = JSON.stringify(entry.id);
		assert.equal(typeof entry.id, "string", label);
		assert.ok(entry.id.length > 0 && entry.id.length <= 200, label);
		assert.ok(rate(entry.input) && rate(entry.output), label);
		assert.ok(entry.provider in OFFICIAL_HOSTS, label);
		const source = new URL(entry.source);
		assert.equal(source.protocol, "https:", label);
		assert.equal(source.hostname, OFFICIAL_HOSTS[entry.provider], label);
		assert.match(entry.asOf, DATE, label);
		assert.ok(!Number.isNaN(Date.parse(entry.asOf)), label);
		assert.ok(entry.asOf <= today, `${label} is dated after today`);
		const allowed = ["id", "provider", "input", "output", "aliases", "datedIds", "longContext", "changes"];
		for (const key of Object.keys(entry))
			assert.ok([...allowed, "source", "asOf"].includes(key), `${label} has unknown key ${key}`);
		for (const id of [entry.id, ...(entry.aliases ?? [])]) {
			const key = id.trim().toLowerCase();
			assert.ok(!seen.has(key), `${id} is listed twice`);
			seen.add(key);
		}
		if (entry.datedIds !== undefined) assert.equal(entry.datedIds, true, label);
		if (entry.longContext) {
			const long = entry.longContext;
			assert.ok(Number.isSafeInteger(long.aboveInputTokens) && long.aboveInputTokens > 0, label);
			assert.ok(rate(long.input) && rate(long.output), label);
			assert.ok(long.input >= entry.input && long.output >= entry.output, `${label} long-context rates are lower`);
		}
		for (const change of entry.changes ?? []) {
			assert.match(change.from, DATE, label);
			assert.ok(change.from > entry.asOf, `${label} lists a change that already applied when it was read`);
			assert.ok(rate(change.input) && rate(change.output), label);
		}
	}
});

test("model ids match exactly, by alias, by an allowed dated suffix, case-insensitively and with Gemini's models/ prefix", () => {
	const id = (modelId) => prices.builtinModelPrice(modelId, NOW)?.id ?? null;
	assert.equal(id("claude-opus-5-5"), "claude-opus-5-5");
	assert.equal(id("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
	assert.equal(id("claude-haiku-4-5"), "claude-haiku-4-5");
	assert.equal(id("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
	// Anthropic snapshots keep their alias's price, so an unlisted dated id still matches.
	assert.equal(id("claude-sonnet-5-5-20261001"), "claude-sonnet-5-5");
	assert.equal(id(" Claude-Opus-5-5 "), "claude-opus-5-5");
	assert.equal(id("models/gemini-2.5-flash"), "gemini-2.5-flash");
	assert.equal(id("gemini-3.1-pro-preview-customtools"), "gemini-3.1-pro-preview");
	// OpenAI snapshots can differ in price: only listed ids match.
	assert.equal(id("gpt-4o-2024-05-13"), "gpt-4o-2024-05-13");
	assert.equal(prices.builtinModelPrice("gpt-4o-2024-05-13", NOW).input, 5);
	assert.equal(id("gpt-4o-2024-08-06"), null);
	assert.equal(id("@cf/moonshotai/kimi-k2.5"), "@cf/moonshotai/kimi-k2.5");
	for (const unknown of ["fake-triage", "claude-opus-5-5-preview", "anthropic/claude-opus-5-5", "", "gpt-4o-mini-2"])
		assert.equal(id(unknown), null, unknown);
});

test("the current Anthropic Opus, Sonnet and Haiku models have built-in prices", () => {
	const at = (modelId) => {
		const price = prices.builtinModelPrice(modelId, NOW);
		return price && [price.input, price.output];
	};
	assert.deepEqual(at("claude-opus-5-5"), [4, 20]);
	assert.deepEqual(at("claude-sonnet-5-5"), [2, 10]);
	assert.deepEqual(at("claude-haiku-5-5"), [0.1, 0.5]);
	assert.deepEqual(prices.builtinModelPrice("claude-haiku-5-5", NOW).longContext, {
		aboveInputTokens: 100_000,
		input: 0.5,
		output: 2.5,
	});
	assert.equal(
		prices.builtinModelPrice("claude-opus-5-5", NOW).source,
		"https://platform.claude.com/docs/en/about-claude/pricing",
	);
});

test("a scheduled price change applies from its UTC date", () => {
	const argon = (iso) => prices.builtinModelPrice("gemini-4-argon", new Date(iso));
	assert.deepEqual([argon("2026-11-30T23:59:59Z").input, argon("2026-11-30T23:59:59Z").output], [2, 10]);
	assert.deepEqual([argon("2026-12-01T00:00:00Z").input, argon("2026-12-01T00:00:00Z").output], [4, 20]);
	const entries = [
		{
			id: "m",
			provider: "openai",
			input: 1,
			output: 2,
			changes: [
				{ from: "2027-02-01", input: 5, output: 6 },
				{ from: "2027-01-01", input: 3, output: 4 },
			],
			source: "https://platform.openai.com/docs/pricing",
			asOf: "2026-10-28",
		},
	];
	const at = (iso) => {
		const price = prices.builtinModelPrice("m", new Date(iso), entries);
		return [price.input, price.output];
	};
	assert.deepEqual(at("2026-12-31T12:00:00Z"), [1, 2]);
	assert.deepEqual(at("2027-01-15T12:00:00Z"), [3, 4]);
	assert.deepEqual(at("2027-03-01T12:00:00Z"), [5, 6]);
});

test("rates resolve as the admin's saved rate, then Kite's price list, then none", () => {
	const saved = {
		// Typed by the admin (or published by the provider and saved with the model list): wins outright.
		"claude-opus-5-5": { input: 3, output: 15 },
		// Only one field typed: that field wins, the other comes from the list.
		"claude-sonnet-5-5": { input: 1.5, output: null, reasoningEffort: "low" },
		// Saved without rates (the default for a model on the list): the list fills in, the effort stays.
		"claude-haiku-5-5": { input: null, output: null, reasoningEffort: "minimal" },
		"fake-model": { input: null, output: null },
		"priced-elsewhere": { input: 0.2, output: 0.4 },
	};
	const models = [
		"claude-opus-5-5",
		"claude-sonnet-5-5",
		"claude-haiku-5-5",
		"fake-model",
		"claude-haiku-4-5-20251001",
		"unlisted",
	];
	const resolved = prices.resolveAgentModelRates(saved, models, NOW);
	assert.deepEqual(resolved["claude-opus-5-5"], { input: 3, output: 15 });
	assert.deepEqual(resolved["claude-sonnet-5-5"], { input: 1.5, output: 10, reasoningEffort: "low" });
	assert.deepEqual(resolved["claude-haiku-5-5"], {
		input: 0.1,
		output: 0.5,
		reasoningEffort: "minimal",
		longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
	});
	assert.deepEqual(resolved["claude-haiku-4-5-20251001"], { input: 1, output: 5 });
	assert.deepEqual(resolved["fake-model"], { input: null, output: null });
	assert.deepEqual(resolved["priced-elsewhere"], { input: 0.2, output: 0.4 });
	assert.equal("unlisted" in resolved, false);
	assert.deepEqual(saved["claude-haiku-5-5"], { input: null, output: null, reasoningEffort: "minimal" });
	assert.equal(spend.spendMode(resolved["fake-model"]), "tokens");
	assert.equal(spend.spendMode(resolved.unlisted), "tokens");
	assert.equal(spend.spendMode(resolved["claude-opus-5-5"]), "cost");
});

test("long-context rates apply to a prompt over the threshold, in estimates, reconciliation and usage rows", () => {
	const haiku = prices.resolveAgentModelRates({}, ["claude-haiku-5-5"], NOW)["claude-haiku-5-5"];
	assert.deepEqual(spend.ratesForPrompt(haiku, 100_000), { input: 0.1, output: 0.5 });
	assert.deepEqual(spend.ratesForPrompt(haiku, 100_001), { input: 0.5, output: 2.5 });
	assert.equal(spend.ratesForPrompt({ input: 1, output: null }, 10), null);
	assert.equal(spend.ratesForPrompt(undefined, 10), null);
	// 400,000 characters estimate 100,000 tokens: still the base tier.
	assert.equal(spend.estimateSpend(400_000, 1_000, haiku).costUsdMicros, 100_000 * 0.1 + 1_000 * 0.5);
	assert.equal(spend.estimateSpend(400_004, 1_000, haiku).costUsdMicros, Math.ceil(100_001 * 0.5 + 1_000 * 2.5));
	assert.equal(
		spend.actualSpend("cost", { inputTokens: 200_000, outputTokens: 1_000 }, haiku).costUsdMicros,
		200_000 * 0.5 + 1_000 * 2.5,
	);
	assert.equal(pricing.calculateAgentCostUsdMicros({ inputTokens: 1_000, outputTokens: 100 }, haiku), 150);
	assert.equal(pricing.calculateAgentCostUsdMicros({ inputTokens: 1_000, outputTokens: 100 }, undefined), null);
});

test("the price list does not change which model automatic reading and line summaries choose", () => {
	const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
	const choose = (saved) =>
		triage.chooseTriageModelId({ triageModelId: null, mailboxModelId: "claude-opus-5-5", models, rates: saved });
	const saved = Object.fromEntries(models.map((id) => [id, { input: null, output: null }]));
	// The price list prices every one of them, and spend counts with those rates...
	const effective = prices.resolveAgentModelRates(saved, models, NOW);
	assert.ok(models.every((id) => spend.spendMode(effective[id]) === "cost"));
	// ...but the choice runs over the saved rates, so it stays on the mailbox's model, as before the list existed.
	assert.equal(choose(saved), "claude-opus-5-5");
	assert.equal(choose({}), "claude-opus-5-5");
	// Rates the admin entered (or the provider published) still steer it, as before.
	assert.equal(choose({ ...saved, "claude-sonnet-5-5": { input: 0.01, output: 0.01 } }), "claude-sonnet-5-5");
	// Both callers pass the saved rates, never the resolved ones.
	for (const file of ["src/lib/agent/auto-read/triage-run.ts", "src/lib/agent/summaries/line-job.ts"]) {
		const source = readFileSync(join(root, file), "utf8");
		const call = source.slice(
			source.indexOf("chooseTriageModelId({"),
			source.indexOf("});", source.indexOf("chooseTriageModelId({")),
		);
		assert.match(call, /rates: config\.rates,/, file);
		assert.doesNotMatch(call, /effectiveRates/, file);
	}
});

test("the cost rates list shows the provider's rate, then Kite's greyed price, and an override", () => {
	const loaded = [{ id: "published", name: "published", rates: { input: 1, output: 2 } }];
	assert.equal(costRates.costRateView("published", {}, loaded, false, NOW).kind, "provider");
	const builtin = costRates.costRateView("claude-opus-5-5", {}, loaded, false, NOW);
	assert.equal(builtin.kind, "builtin");
	assert.deepEqual([builtin.price.input, builtin.price.output, builtin.price.asOf], [4, 20, "2026-10-28"]);
	const empty = { "claude-opus-5-5": { input: null, output: null } };
	assert.equal(costRates.costRateView("claude-opus-5-5", empty, [], false, NOW).kind, "builtin");
	const overriding = costRates.costRateView("claude-opus-5-5", empty, [], true, NOW);
	assert.equal(overriding.kind, "manual");
	assert.equal(overriding.builtin.input, 4);
	const own = costRates.costRateView(
		"claude-opus-5-5",
		{ "claude-opus-5-5": { input: 3, output: null } },
		[],
		false,
		NOW,
	);
	assert.equal(own.kind, "manual");
	assert.deepEqual(costRates.costRateView("fake-model", {}, [], false, NOW), { kind: "manual", builtin: null });

	const form = {
		provider: "compatible",
		preset: "anthropic",
		baseUrl: "",
		apiKey: "",
		model: "claude-opus-5-5",
		rates: { "claude-opus-5-5": { input: null, output: null, reasoningEffort: "low" } },
	};
	const overridden = costRates.overrideAgentModelRate(form, "claude-opus-5-5", builtin.price);
	assert.deepEqual(overridden.rates["claude-opus-5-5"], { input: 4, output: 20, reasoningEffort: "low" });
	assert.deepEqual(costRates.clearAgentModelRate(overridden, "claude-opus-5-5").rates["claude-opus-5-5"], {
		input: null,
		output: null,
		reasoningEffort: "low",
	});
	assert.equal(form.rates["claude-opus-5-5"].input, null);
	assert.equal(
		costRates.longContextText(prices.builtinModelPrice("claude-haiku-5-5", NOW)),
		"Over 100,000 input tokens: input $0.50 · output $2.50 / 1M",
	);
	assert.equal(costRates.longContextText(builtin.price), null);
	assert.deepEqual([4, 0.1, 0.027, 2.253, 0].map(costRates.formatRate), ["4.00", "0.10", "0.027", "2.253", "0.00"]);
});

test("today's spend is shown against the cap, rounded up to the cent", () => {
	assert.equal(settingsUi.spentTodayText(0, 2_000_000), "Spent today: $0.00 of $2.00");
	assert.equal(settingsUi.spentTodayText(1, 2_000_000), "Spent today: $0.01 of $2.00");
	assert.equal(settingsUi.spentTodayText(1_234_567, 1_500_000), "Spent today: $1.24 of $1.50");
});
