import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-auto-read-ui-");
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

const ui = await bundle("src/components/agent/auto-read-settings-utils.ts", "auto-read-ui.mjs");
const rates = await bundle("src/lib/agent/model-rates-utils.ts", "model-rates.mjs");

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const response = {
	settings: {
		mailboxId: "mb1",
		modelId: "m",
		autonomy: "suggest",
		capabilities: { calendar: false, reply: true, summary: false, phishing: true, mutedSenders: ["x@y.test"] },
		triageModelId: "fake-triage",
		autoReadDailyLimit: 50,
		dailySpendCapMicros: 500_000,
		pausedUntil: null,
	},
	models: ["fake-triage", "fake-draft"],
	canManage: true,
	autoReadAvailable: true,
	externalProviderBlocked: false,
	providerLabel: "127.0.0.1",
};

test("only Off and Suggest only can be chosen", () => {
	assert.deepEqual(
		ui.AUTONOMY_OPTIONS.map((option) => [option.value, option.available]),
		[
			["off", true],
			["suggest", true],
			["act", false],
			["auto", false],
		],
	);
	assert.deepEqual(ui.CAPABILITY_OPTIONS.map((option) => option.key).sort(), [
		"calendar",
		"phishing",
		"reply",
		"summary",
	]);
});

test("dollar inputs round-trip through micro-dollars", () => {
	assert.equal(ui.microsToDollarInput(null), "");
	assert.equal(ui.microsToDollarInput(undefined), "");
	assert.equal(ui.microsToDollarInput(500_000), "0.50");
	assert.equal(ui.microsToDollarInput(2_000_000), "2.00");
	assert.equal(ui.microsToDollarInput(1234), "0.001234");
	assert.equal(ui.parseDollarInput(""), null);
	assert.equal(ui.parseDollarInput("  "), null);
	assert.equal(ui.parseDollarInput("0.5"), 500_000);
	assert.equal(ui.parseDollarInput("1.00"), 1_000_000);
	assert.equal(ui.parseDollarInput("0"), 0);
	assert.equal(ui.parseDollarInput("-1"), undefined);
	assert.equal(ui.parseDollarInput("abc"), undefined);
});

test("the settings response becomes form state, and a response without auto-read fields gives none", () => {
	const state = ui.toAutoReadState(response, NOW);
	assert.deepEqual(state.form, {
		autonomy: "suggest",
		capabilities: { calendar: false, reply: true, summary: false, phishing: true },
		triageModelId: "fake-triage",
		dailyLimit: "50",
		spendCap: "0.50",
	});
	assert.equal(state.canManage, true);
	assert.equal(state.providerLabel, "127.0.0.1");
	assert.equal(ui.toAutoReadState({ settings: { mailboxId: "mb1" } }, NOW), null);

	const sparse = ui.toAutoReadState(
		{
			settings: { ...response.settings, triageModelId: null, dailySpendCapMicros: null, autoReadDailyLimit: undefined },
		},
		NOW,
	);
	assert.deepEqual(
		{ ...sparse, form: undefined },
		{
			form: undefined,
			savedAutonomy: "suggest",
			pausedUntil: null,
			models: [],
			canManage: false,
			autoReadAvailable: true,
			externalProviderBlocked: false,
			providerLabel: "the configured AI provider",
		},
	);
	assert.equal(sparse.form.triageModelId, "");
	assert.equal(sparse.form.spendCap, "");
	assert.equal(sparse.form.dailyLimit, "200");
});

test("the update body carries the form values but never the muted senders", () => {
	const { form } = ui.toAutoReadState(response, NOW);
	assert.deepEqual(ui.autoReadUpdateBody("mb1", form), {
		mailboxId: "mb1",
		autonomy: "suggest",
		capabilities: { calendar: false, reply: true, summary: false, phishing: true },
		triageModelId: "fake-triage",
		autoReadDailyLimit: 50,
		dailySpendCapMicros: 500_000,
	});
	assert.equal(ui.autoReadUpdateBody("mb1", { ...form, triageModelId: "", spendCap: "" }).triageModelId, null);
	assert.equal(ui.autoReadUpdateBody("mb1", { ...form, spendCap: "" }).dailySpendCapMicros, null);
	for (const dailyLimit of ["0", "1001", "2.5", ""])
		assert.match(ui.autoReadUpdateBody("mb1", { ...form, dailyLimit }), /daily triage limit/);
	assert.match(ui.autoReadUpdateBody("mb1", { ...form, spendCap: "-2" }), /spend cap/);
});

test("only a pause that has not ended yet is loaded as paused", () => {
	const load = (pausedUntil) =>
		ui.toAutoReadState({ ...response, settings: { ...response.settings, pausedUntil } }, NOW);
	assert.equal(load("2026-10-11T12:00:00.000Z").pausedUntil, "2026-10-11T12:00:00.000Z");
	assert.equal(load("2026-10-10T11:00:00.000Z").pausedUntil, null);
	assert.equal(load(null).pausedUntil, null);
});

test("pausing lasts 24 hours", () => {
	assert.equal(ui.pauseEndFrom(NOW), "2026-10-11T12:00:00.000Z");
});

test("the legacy settings body leaves out every automatic reading field", () => {
	const legacy = ui.legacyAgentSettingsBody({
		mailboxId: "mb1",
		enabled: true,
		modelId: "m",
		autoDraftEnabled: true,
		reviewerUserId: "u1",
		instructions: "Be brief",
		dailyLimit: 10,
		...response.settings,
	});
	assert.deepEqual(Object.keys(legacy).sort(), [
		"autoDraftEnabled",
		"dailyLimit",
		"enabled",
		"instructions",
		"mailboxId",
		"modelId",
		"reviewerUserId",
	]);
});

test("published catalog rates merge per model and keep a saved reasoning effort", () => {
	const current = {
		"fake-triage": { input: 1, output: 2, reasoningEffort: "minimal" },
		"fake-draft": { input: 3, output: 4 },
	};
	const merged = rates.mergePublishedAgentRates(current, {
		"fake-triage": { input: 0.05, output: 0.3 },
		"new-model": { input: 0.1, output: 0.2 },
	});
	assert.deepEqual(merged, {
		"fake-triage": { input: 0.05, output: 0.3, reasoningEffort: "minimal" },
		"fake-draft": { input: 3, output: 4 },
		"new-model": { input: 0.1, output: 0.2 },
	});
	assert.deepEqual(current["fake-triage"], { input: 1, output: 2, reasoningEffort: "minimal" });
	assert.deepEqual(rates.mergePublishedAgentRates(current, {}), current);
});
