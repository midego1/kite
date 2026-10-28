import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-settings-");
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

const settings = await bundle("src/lib/agent/auto-read/settings-utils.ts", "settings.mjs");
const efforts = await bundle("src/lib/agent/reasoning-effort-utils.ts", "efforts.mjs");
const pricing = await bundle("src/lib/agent/pricing.ts", "pricing.mjs");

const personal = { mailboxId: "mb1", ownerUserId: "u1", mailboxType: "personal" };
const shared = { mailboxId: "mb2", ownerUserId: "u1", mailboxType: "shared" };

function parseUpdate(body) {
	return settings.mailboxAgentSettingsUpdateSchema.safeParse({ mailboxId: "mb1", ...body });
}

test("a mailbox without a settings row gets the automatic reading defaults", () => {
	const state = settings.resolveMailboxAgentSettings(undefined, personal);
	assert.deepEqual(state, {
		mailboxId: "mb1",
		modelId: null,
		autoDraftEnabled: false,
		reviewerUserId: "u1",
		instructions: "",
		chatInstructions: "",
		draftInstructions: "",
		summaryInstructions: "",
		dailyLimit: 25,
		autonomy: "off",
		capabilities: {
			calendar: true,
			reply: true,
			summary: true,
			phishing: true,
			mutedSenders: [],
			trustedSenders: [],
			modules: {},
		},
		triageModelId: null,
		autoReadDailyLimit: 200,
		dailySpendCapMicros: null,
		pausedUntil: null,
		listSummaries: false,
		listSummariesBulk: false,
		listSummaryDailyLimit: 100,
	});
	assert.equal(settings.resolveMailboxAgentSettings(undefined, shared).capabilities.calendar, false);
});

test("stored rows are read back with parsed capabilities and a safe autonomy", () => {
	const pausedUntil = new Date("2026-10-11T00:00:00.000Z");
	const row = {
		mailboxId: "mb2",
		modelId: "m",
		autoDraftEnabled: true,
		reviewerUserId: null,
		instructions: "Be brief",
		dailyLimit: 10,
		autonomy: "suggest",
		capabilities:
			'{"calendar":true,"reply":false,"summary":"yes","mutedSenders":["A@x.test"," a@x.test ",3],"trustedSenders":["Bank@Y.test",false]}',
		triageModelId: "t",
		autoReadDailyLimit: 5,
		dailySpendCapMicros: 0,
		pausedUntil,
	};
	const state = settings.resolveMailboxAgentSettings(row, shared);
	assert.equal(state.autonomy, "suggest");
	assert.deepEqual(state.capabilities, {
		calendar: true,
		reply: false,
		summary: true,
		phishing: true,
		mutedSenders: ["a@x.test"],
		trustedSenders: ["bank@y.test"],
		modules: {},
	});
	assert.equal(state.pausedUntil, pausedUntil);
	assert.equal(settings.resolveMailboxAgentSettings({ ...row, autonomy: "bogus" }, shared).autonomy, "off");
	for (const capabilities of ["not json", "[]", null, '{"mutedSenders":"x"}'])
		assert.deepEqual(settings.resolveMailboxAgentSettings({ ...row, capabilities }, shared).capabilities, {
			calendar: false,
			reply: true,
			summary: true,
			phishing: true,
			mutedSenders: [],
			trustedSenders: [],
			modules: {},
		});
});

test("the update schema enforces the documented ranges", () => {
	for (const body of [
		{ autoReadDailyLimit: 0 },
		{ autoReadDailyLimit: 1001 },
		{ autoReadDailyLimit: 1.5 },
		{ dailySpendCapMicros: -1 },
		{ pausedUntil: "not-a-date" },
		{ autonomy: "manual" },
		{ capabilities: { calendar: "on" } },
		{ capabilities: { mutedSenders: [""] } },
	])
		assert.equal(parseUpdate(body).success, false, JSON.stringify(body));
	for (const body of [
		{ autoReadDailyLimit: 1 },
		{ autoReadDailyLimit: 1000 },
		{ dailySpendCapMicros: null },
		{ dailySpendCapMicros: 0 },
		{ pausedUntil: null },
		{ pausedUntil: "2026-10-11T12:00:00.000Z" },
		{ pausedUntil: "2026-10-11T12:00:00+02:00" },
		{ autonomy: "act" },
		{},
	])
		assert.equal(parseUpdate(body).success, true, JSON.stringify(body));
});

test("invalid fields get a message naming them", () => {
	const message = (body) => settings.describeSettingsError(parseUpdate(body).error);
	assert.match(message({ autoReadDailyLimit: 0 }), /between 1 and 1000/);
	assert.match(message({ dailySpendCapMicros: -1 }), /spend cap/);
	assert.match(message({ pausedUntil: "x" }), /ISO date/);
	assert.match(message({ autonomy: "x" }), /autonomy/);
	assert.equal(
		settings.describeSettingsError(settings.mailboxAgentSettingsUpdateSchema.safeParse(null).error),
		"Invalid settings",
	);
});

test("only Off and Suggest only can be chosen", () => {
	assert.equal(settings.autonomyError(undefined), null);
	assert.equal(settings.autonomyError("off"), null);
	assert.equal(settings.autonomyError("suggest"), null);
	assert.match(settings.autonomyError("act"), /not available yet/);
	assert.match(settings.autonomyError("auto"), /not available yet/);
});

test("a partial update keeps every field it leaves out", () => {
	const current = settings.resolveMailboxAgentSettings(undefined, shared);
	const next = settings.applyMailboxAgentSettingsUpdate(current, parseUpdate({ autonomy: "suggest" }).data);
	assert.deepEqual(next, { ...current, autonomy: "suggest" });
	const full = settings.applyMailboxAgentSettingsUpdate(
		current,
		parseUpdate({
			modelId: "m",
			autoDraftEnabled: true,
			reviewerUserId: "u2",
			instructions: "Hi",
			dailyLimit: 3,
			triageModelId: "t",
			autoReadDailyLimit: 7,
			dailySpendCapMicros: 50,
			pausedUntil: "2026-10-11T12:00:00.000Z",
			capabilities: { calendar: true, summary: false },
		}).data,
	);
	assert.equal(full.pausedUntil.toISOString(), "2026-10-11T12:00:00.000Z");
	assert.deepEqual(full.capabilities, {
		calendar: true,
		reply: true,
		summary: false,
		phishing: true,
		mutedSenders: [],
		trustedSenders: [],
		modules: {},
	});
	assert.equal(full.autoReadDailyLimit, 7);
	assert.equal(full.dailySpendCapMicros, 50);
	const cleared = settings.applyMailboxAgentSettingsUpdate(
		full,
		parseUpdate({ pausedUntil: null, dailySpendCapMicros: null, triageModelId: null }).data,
	);
	assert.equal(cleared.pausedUntil, null);
	assert.equal(cleared.dailySpendCapMicros, null);
	assert.equal(cleared.triageModelId, null);
});

test("saving capabilities never drops muted senders", () => {
	const base = settings.resolveMailboxAgentSettings(undefined, personal);
	const current = { ...base, capabilities: { ...base.capabilities, mutedSenders: ["a@x.test"] } };
	const merge = (capabilities) =>
		settings.applyMailboxAgentSettingsUpdate(current, parseUpdate({ capabilities }).data).capabilities;
	assert.deepEqual(merge({ reply: false }), { ...current.capabilities, reply: false });
	assert.deepEqual(merge({ mutedSenders: [] }).mutedSenders, ["a@x.test"]);
	assert.deepEqual(merge({ mutedSenders: ["B@Y.test", "a@x.test"] }).mutedSenders, ["a@x.test", "b@y.test"]);
	assert.deepEqual(merge(undefined), current.capabilities);
});

test("saving capabilities keeps trusted senders as stored and cannot set them", () => {
	const base = settings.resolveMailboxAgentSettings(undefined, personal);
	const current = { ...base, capabilities: { ...base.capabilities, trustedSenders: ["bank@x.test"] } };
	const parsed = parseUpdate({ capabilities: { reply: false, trustedSenders: ["evil@x.test"] } });
	assert.equal(parsed.success, true);
	const merged = settings.applyMailboxAgentSettingsUpdate(current, parsed.data).capabilities;
	assert.deepEqual(merged.trustedSenders, ["bank@x.test"]);
	assert.equal(merged.reply, false);
});

test("module step switches are kept per key, merged on save, and malformed keys or values are dropped", () => {
	const row = (capabilities) => ({
		mailboxId: "mb2",
		modelId: null,
		autoDraftEnabled: false,
		reviewerUserId: null,
		instructions: "",
		dailyLimit: 10,
		autonomy: "suggest",
		capabilities,
		triageModelId: null,
		autoReadDailyLimit: 5,
		dailySpendCapMicros: null,
		pausedUntil: null,
	});
	const read = (value) => settings.resolveMailboxAgentSettings(row(value), personal).capabilities.modules;
	assert.deepEqual(read('{"modules":{"widgets":false,"gadgets":true}}'), { widgets: false, gadgets: true });
	assert.deepEqual(read('{"modules":{"Bad Key":false,"widgets":"no","__proto__":false,"ok_1":false}}'), {
		ok_1: false,
	});
	for (const modules of ["[]", '"x"', "null", "3"]) assert.deepEqual(read(`{"modules":${modules}}`), {});
	const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, false]));
	assert.equal(Object.keys(read(JSON.stringify({ modules: many }))).length, 32);

	const current = settings.resolveMailboxAgentSettings(row('{"modules":{"widgets":false}}'), personal);
	const merge = (capabilities) =>
		settings.applyMailboxAgentSettingsUpdate(current, parseUpdate({ capabilities }).data).capabilities.modules;
	assert.deepEqual(merge({ modules: { gadgets: false } }), { widgets: false, gadgets: false });
	assert.deepEqual(merge({ modules: { widgets: true } }), { widgets: true });
	assert.deepEqual(merge({ reply: false }), { widgets: false });
	assert.equal(parseUpdate({ capabilities: { modules: { "Bad Key": true } } }).success, false);
	assert.equal(parseUpdate({ capabilities: { modules: { widgets: "yes" } } }).success, false);
	assert.equal(parseUpdate({ capabilities: { modules: many } }).success, false);
});

test("muted senders over capacity are refused instead of evicting existing ones", () => {
	const base = settings.resolveMailboxAgentSettings(undefined, personal);
	const full = Array.from({ length: 500 }, (_, index) => `s${index}@x.test`);
	const current = { ...base, capabilities: { ...base.capabilities, mutedSenders: full } };
	const update = (mutedSenders) => parseUpdate({ capabilities: { mutedSenders } }).data;
	assert.match(settings.mutedSendersError(current, update(["new@x.test"])), /500/);
	assert.equal(settings.mutedSendersError(current, update(["S0@x.test", "s499@x.test"])), null);
	assert.equal(settings.mutedSendersError(current, parseUpdate({ autonomy: "off" }).data), null);
	const merged = settings.applyMailboxAgentSettingsUpdate(current, update(["new@x.test"])).capabilities.mutedSenders;
	assert.equal(merged[0], "s0@x.test");
	assert.equal(merged.length, 501);
	const almost = { ...base, capabilities: { ...base.capabilities, mutedSenders: full.slice(1) } };
	assert.equal(settings.mutedSendersError(almost, update(["new@x.test"])), null);
});

test("the reviewer needs send permission only when an update turns on or re-points auto-drafting", () => {
	const current = { ...settings.resolveMailboxAgentSettings(undefined, shared), reviewerUserId: null };
	const apply = (body, from = current) => settings.applyMailboxAgentSettingsUpdate(from, parseUpdate(body).data);
	const required = (body, from = current) => settings.requiredReviewerAccess(from, apply(body, from), "u1");
	for (const body of [
		{ autonomy: "suggest" },
		{ autonomy: "off" },
		{ pausedUntil: "2026-10-11T12:00:00.000Z" },
		{ pausedUntil: null },
		{ capabilities: { reply: false } },
		{ autoReadDailyLimit: 5, dailySpendCapMicros: 0, triageModelId: null },
		{ reviewerUserId: "u1" },
	])
		assert.equal(required(body), null, JSON.stringify(body));
	assert.equal(required({ autoDraftEnabled: true }), "send");
	assert.equal(required({ reviewerUserId: "u2" }), "read");
	const drafting = { ...current, autoDraftEnabled: true };
	assert.equal(required({ autonomy: "off", autoDraftEnabled: true }, drafting), null);
	assert.equal(required({ reviewerUserId: "u2" }, drafting), "send");
	assert.equal(required({ autoDraftEnabled: false, reviewerUserId: "u2" }, drafting), "read");
});

test("configured model checks fall back or reject unknown ids", () => {
	assert.equal(settings.configuredModelId("a", ["a", "b"], null), "a");
	assert.equal(settings.configuredModelId("z", ["a", "b"], "a"), "a");
	assert.equal(settings.configuredModelId(null, ["a"], null), null);
	assert.equal(settings.unknownModelError({ mailboxId: "m" }, ["a"]), null);
	assert.equal(settings.unknownModelError({ mailboxId: "m", modelId: "a", triageModelId: "a" }, ["a"]), null);
	assert.match(settings.unknownModelError({ mailboxId: "m", modelId: "z" }, ["a"]), /configured model/);
	assert.match(settings.unknownModelError({ mailboxId: "m", triageModelId: "z" }, ["a"]), /triage model/);
});

test("the provider label names Workers AI, a preset or the custom host", () => {
	const install = { agentEnabled: true, autoReadEnabled: true, externalAutoReadAllowed: true, dailySpendCapMicros: 1 };
	const label = (provider) => settings.autoReadInstallFlags(install, provider).providerLabel;
	assert.equal(label({ provider: "cloudflare", preset: "openai", baseUrl: "" }), "Workers AI");
	assert.equal(label({ provider: "compatible", preset: "haimaker", baseUrl: "" }), "Haimaker.ai");
	assert.equal(label({ provider: "compatible", preset: "anthropic", baseUrl: "" }), "Anthropic");
	assert.equal(label({ provider: "compatible", preset: "openrouter", baseUrl: "" }), "OpenRouter");
	assert.equal(label({ provider: "compatible", preset: "openai", baseUrl: "" }), "OpenAI");
	assert.equal(label({ provider: "compatible", preset: "groq", baseUrl: "" }), "Groq");
	assert.equal(label({ provider: "compatible", preset: "custom", baseUrl: "http://127.0.0.1:3301/v1" }), "127.0.0.1");
	assert.equal(
		label({ provider: "compatible", preset: "custom", baseUrl: "https://llm.provider.test/v1" }),
		"llm.provider.test",
	);
	assert.equal(label({ provider: "compatible", preset: "custom", baseUrl: "not a url" }), "a custom provider");
});

test("install flags combine the switches with the provider", () => {
	const install = { agentEnabled: true, autoReadEnabled: true, externalAutoReadAllowed: false, dailySpendCapMicros: 1 };
	const compatible = { provider: "compatible", preset: "custom", baseUrl: "http://127.0.0.1:3301" };
	const cloudflare = { provider: "cloudflare", preset: "openai", baseUrl: "" };
	assert.deepEqual(settings.autoReadInstallFlags(install, compatible), {
		autoReadAvailable: true,
		externalProviderBlocked: true,
		providerLabel: "127.0.0.1",
	});
	assert.equal(
		settings.autoReadInstallFlags({ ...install, externalAutoReadAllowed: true }, compatible).externalProviderBlocked,
		false,
	);
	assert.equal(settings.autoReadInstallFlags(install, cloudflare).externalProviderBlocked, false);
	assert.equal(settings.autoReadInstallFlags({ ...install, agentEnabled: false }, cloudflare).autoReadAvailable, false);
	assert.equal(
		settings.autoReadInstallFlags({ ...install, autoReadEnabled: false }, cloudflare).autoReadAvailable,
		false,
	);
});

test("the admin auto-read branch takes only its own keys, validated strictly", () => {
	assert.equal(settings.isAutoReadAdminBody({ autoReadEnabled: false }), true);
	assert.equal(settings.isAutoReadAdminBody({ externalAutoReadAllowed: true, dailySpendCapMicros: 5 }), true);
	for (const body of [null, [], {}, "x", { enabled: true }, { autoReadEnabled: true, provider: "cloudflare" }])
		assert.equal(settings.isAutoReadAdminBody(body), false, JSON.stringify(body));
	const schema = settings.autoReadAdminSchema;
	for (const body of [
		{ dailySpendCapMicros: -5 },
		{ autoReadEnabled: "yes" },
		{ externalAutoReadAllowed: 1 },
		{ dailySpendCapMicros: 1.5 },
	])
		assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
	assert.deepEqual(schema.parse({ dailySpendCapMicros: 0 }), { dailySpendCapMicros: 0 });
	assert.equal(settings.DEFAULT_INSTALL_SPEND_CAP_MICROS, 2_000_000);
});

test("reasoning efforts accept the provider levels and never none", () => {
	for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"])
		assert.equal(efforts.parseAgentReasoningEffort(effort), effort);
	for (const value of ["none", "", null, undefined, 3, "MAX"])
		assert.equal(efforts.parseAgentReasoningEffort(value), undefined);
	assert.equal(efforts.AGENT_REASONING_EFFORTS.includes("none"), false);
});

test("saved model rates keep a valid reasoning effort and drop an invalid one", () => {
	assert.deepEqual(
		pricing.parseAgentModelRates(
			JSON.stringify({
				a: { input: 1, output: 2, reasoningEffort: "minimal" },
				b: { input: 1, output: 2, reasoningEffort: "none" },
				c: { input: null, output: null },
			}),
		),
		{
			a: { input: 1, output: 2, reasoningEffort: "minimal" },
			b: { input: 1, output: 2 },
			c: { input: null, output: null },
		},
	);
});
