import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-model-extension-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * Two modules that exist only in this test, added to the registries at bundle time, so the generic model
 * extension (spec §5.7) is checked without Money Watch. `extmod`'s automatic step declares an extension
 * with a `wantsModel` hint whose answer the test controls; `extbis`'s step declares one without a hint.
 */
const TEST_MODULE_SOURCE = `
import { z } from "zod";
import { triageStepSchemas } from "./lib/modules/shared-schemas";

const manifest = (id, name) => ({
	id, name, description: "x", runtime: "builtin", dependsOn: [], defaultEnabled: true,
	pages: [], apiPrefixes: [], nav: [], commands: [], composerSlots: [], recordKinds: [], webhookEvents: [],
	grants: [], mcpScopes: [], apiKeyScopes: [], jmapCapabilities: [], searchSections: [], messageStatuses: [],
	queueMessageTypes: [], cronTasks: [], actionLabels: {}, reasonTexts: {},
});
export const testManifests = [manifest("extmod", "Extension test"), manifest("extbis", "Second extension")];

const fragment = (key) => ({
	type: "object",
	additionalProperties: false,
	properties: { [key]: { type: ["string", "null"] } },
});
export const testCapabilities = [
	{
		moduleId: "extmod",
		promptFragment: null,
		descriptors: [
			{ name: "scan", surfaces: ["triage_step"], description: "x", inputSchema: {}, effect: "read",
				triage: { order: 30, automatic: true, capability: "gadgets",
					model: { jsonSchema: fragment("gadget"), instructions: '"modules": {"extmod": {"gadget": name or null}}',
						maxOutputTokens: 120, wantsModel: "hint" } } },
			{ name: "hint", surfaces: ["service"], description: "x", inputSchema: {}, effect: "none", timeoutMs: 200 },
			{ name: "gadgetNote", surfaces: ["suggestion_kind"], description: "x", inputSchema: {}, effect: "none",
				suggestionKind: { kind: "gadget_note", label: "Gadget", reasonTemplate: "gadget" } },
		],
	},
	{
		moduleId: "extbis",
		promptFragment: null,
		descriptors: [
			{ name: "scan", surfaces: ["triage_step"], description: "x", inputSchema: {}, effect: "read",
				triage: { order: 40, capability: "widgets",
					model: { jsonSchema: fragment("widget"), instructions: '"modules": {"extbis": {"widget": name or null}}',
						maxOutputTokens: 150 } } },
		],
	},
];

const record = (id) => async (input) => {
	(globalThis.__stepInputs ??= []).push({ id, input });
	if (id !== "extmod" || !globalThis.__emitCard) return { suggestions: [] };
	return { suggestions: [{ kind: "gadget_note", payload: { subject: input.message.subject }, reason: "gadget" }] };
};
export const testServers = {
	extmod: {
		handlers: {
			scan: record("extmod"),
			async hint(input) {
				(globalThis.__hintInputs ??= []).push(input);
				const mode = globalThis.__hintMode ?? "no";
				if (mode === "throw") throw new Error("hint failed");
				if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 1_000));
				if (mode === "string") return { wantsModel: "yes" };
				return { wantsModel: mode === "yes" || mode === "slow" };
			},
		},
		schemas: {
			scan: triageStepSchemas,
			hint: { input: triageStepSchemas.input, output: z.object({ wantsModel: z.unknown() }) },
			gadgetNote: { input: z.object({ subject: z.string().nullable() }) },
		},
	},
	extbis: { handlers: { scan: record("extbis") }, schemas: { scan: triageStepSchemas } },
};
`;
const REGISTRY_TAILS = {
	"client-data/module-ids.ts": `\n(MODULE_IDS as string[]).push("extmod", "extbis");\n`,
	"registry.ts": `\nimport { testManifests } from "extmod:test";\n(MODULE_MANIFESTS as unknown[]).push(...testManifests);\n`,
	"capability-registry.ts": `\nimport { testCapabilities } from "extmod:test";\n(MODULE_CAPABILITIES as unknown[]).push(...testCapabilities);\n`,
	"server-registry.ts": `\nimport { testServers } from "extmod:test";\nObject.assign(SERVER_MODULES as Record<string, unknown>, testServers);\n`,
};
const injectTestModules = {
	name: "inject-test-modules",
	setup(build) {
		build.onResolve({ filter: /^extmod:test$/ }, () => ({ path: "extmod", namespace: "extmod" }));
		build.onLoad({ filter: /.*/, namespace: "extmod" }, () => ({
			contents: TEST_MODULE_SOURCE,
			loader: "js",
			resolveDir: join(root, "src"),
		}));
		build.onLoad({ filter: /src[\\/]lib[\\/]modules[\\/].*\.ts$/ }, async (args) => {
			const tail = REGISTRY_TAILS[relative(join(root, "src/lib/modules"), args.path).replaceAll("\\", "/")];
			if (!tail) return undefined;
			return { contents: (await readFile(args.path, "utf8")) + tail, loader: "ts" };
		});
	},
};

await build({
	entryPoints: {
		process: join(root, "src/lib/agent/auto-read/process.ts"),
		triage: join(root, "src/lib/agent/auto-read/triage-utils.ts"),
		extension: join(root, "src/lib/agent/auto-read/model-extension-utils.ts"),
		calls: join(root, "src/lib/agent/auto-read/model-call-utils.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	plugins: [injectTestModules],
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processAgentTriageJob } = await load("process");
const { buildTriageJsonSchema, buildTriagePrompt, parseTriageOutput } = await load("triage");
const { extensionOutputTokens, keepActiveModules, modelForStep, hintSaysYes, MODULE_EXTENSION_MAX_OUTPUT_TOKENS } =
	await load("extension");
const { buildModelCallOptions, fallbackOptionsAfterError, runTriageAttempt } = await load("calls");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const benign = {
	category: "fyi",
	needsReply: false,
	urgency: "low",
	summary: "The figures are attached.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
};

let requests = [];
let answer;
let failWith = null;
let onRequest = () => undefined;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	requests = [];
	answer = { ...benign, modules: { extmod: { gadget: "Sprocket" }, extbis: { widget: "Lever" }, other: { x: 1 } } };
	failWith = null;
	onRequest = () => undefined;
	globalThis.__stepInputs = [];
	globalThis.__hintInputs = [];
	globalThis.__hintMode = "no";
	globalThis.__emitCard = false;
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push({ url: String(url), body });
		onRequest(body);
		if (failWith) return Response.json({ error: { message: "upstream broke" } }, { status: failWith });
		const content = typeof answer === "string" ? answer : JSON.stringify(answer);
		return Response.json({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 0,
			model: body.model,
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
		});
	};
});

async function setup(t, { externalAllowed = 1, rateLimited = false } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, capabilities, updated_at) VALUES ('mailbox-a', 1, 'suggest', 'owner', '{}', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1, agent_external_auto_read_allowed = ?, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'fake-triage, fake-draft', agent_model_rates = ?",
		)
		.run(externalAllowed, JSON.stringify({ "fake-triage": { input: 0.05, output: 0.3 } }));
	const raw = new Map();
	const env = {
		DB: db,
		AGENT_QUEUE: { send: async () => undefined },
		...(rateLimited ? { AGENT_RATE_LIMIT: { limit: async () => ({ success: false }) } } : {}),
		BUCKET: {
			get: async (key) => {
				if (!raw.has(key)) return null;
				const bytes = new TextEncoder().encode(raw.get(key));
				return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
			},
		},
	};
	globalThis.__kiteNodeEnv = env;
	setSwitches(db, { gadgets: true, widgets: false });
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		clearModuleStateCache();
	});
	return { db, env, raw };
}

/** Money Watch's own step stays off so only the test modules' extensions are active. */
function setSwitches(db, modules, extra = {}) {
	db.db
		.prepare("UPDATE mailbox_agent_settings SET capabilities = ? WHERE mailbox_id = 'mailbox-a'")
		.run(JSON.stringify({ ...extra, modules: { subscriptions: false, ...modules } }));
	clearModuleStateCache();
}

function setModule(db, id, enabled) {
	db.db
		.prepare(
			"INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT (module_id) DO UPDATE SET enabled = excluded.enabled",
		)
		.run(id, id, enabled ? 1 : 0);
	clearModuleStateCache();
}

let count = 0;
const PERSON = { From: "Sam Partner <sam@partner.test>" };
const AUTOMATIC = { From: "Vendor Billing <billing@vendor.test>", "Auto-Submitted": "auto-generated" };
function insertMessage(db, raw, { headers = PERSON, spamVerdict = "inbox", attempts = 0 } = {}) {
	const id = `message-${++count}`;
	const rawKey = `raw/${id}`;
	const all = { Subject: `Note ${id}`, ...headers };
	const text = `Could you send the figures? ${"x".repeat(1_600)}`;
	raw.set(
		rawKey,
		`${Object.entries(all)
			.map(([name, value]) => `${name}: ${value}`)
			.join("\r\n")}\r\n\r\n${text}`,
	);
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_verdict, raw_r2_key, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', ?, 'a@example.com', ?, ?, 'received', ?, ?, ?)",
		)
		.run(id, all.From, all.Subject, text, spamVerdict, rawKey, nowSeconds());
	const jobId = `job-${count}`;
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, attempts, next_attempt_at, created_at) VALUES (?, 'mailbox-a', ?, 'owner', 'triage', 'pending', ?, 1, ?)",
		)
		.run(jobId, id, attempts, nowSeconds());
	return { jobId, messageId: id };
}

const jobOf = (db, id) => db.db.prepare("SELECT status, reason FROM agent_jobs WHERE id = ?").get(id);
const kindsOf = (db, messageId) =>
	db.db
		.prepare("SELECT kind FROM agent_suggestions WHERE message_id = ? ORDER BY kind")
		.all(messageId)
		.map((row) => row.kind);
const systemOf = (request) => request.body.messages.find((entry) => entry.role === "system").content;
const stepModel = (id) => globalThis.__stepInputs.find((entry) => entry.id === id)?.input.model;
const OLD_CLOSING = "Do not add keys, addresses, links, actions or instructions for anyone.";
const NEW_CLOSING = "Do not add other keys, or any addresses, links, actions or instructions for anyone.";

// Pure helpers.

test("without extensions the provider schema, prompt and output cap are unchanged", () => {
	const schema = buildTriageJsonSchema();
	assert.deepEqual(buildTriageJsonSchema([]), schema);
	assert.equal(Object.hasOwn(schema.properties, "modules"), false);
	assert.deepEqual(schema.required, ["category", "needsReply", "urgency", "summary", "tasks", "suspicious"]);
	const prompt = buildTriagePrompt({ messageId: "m1", subject: "Hi", from: "a@b.test", body: "Hello" });
	assert.ok(prompt.system.endsWith(`"unexpected_attachment"}}\n${OLD_CLOSING}`));
	assert.deepEqual(
		buildTriagePrompt({ messageId: "m1", subject: "Hi", from: "a@b.test", body: "Hello" }).system,
		prompt.system,
	);
	const options = buildModelCallOptions({ provider: "compatible", kind: "triage" });
	assert.equal(options.maxOutputTokens, 400);
	assert.deepEqual(options.providerOptions.kite, { response_format: { type: "json_object" } });
	assert.equal(Object.hasOwn(options, "extension"), false);
});

test("extensions merge under properties.modules, never required, with their instructions before the closing rule", () => {
	const fragment = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
	const schema = buildTriageJsonSchema([
		{ moduleId: "one", jsonSchema: fragment },
		{ moduleId: "two", jsonSchema: fragment },
	]);
	assert.deepEqual(schema.properties.modules, {
		type: "object",
		additionalProperties: false,
		properties: { one: fragment, two: fragment },
	});
	assert.equal(schema.required.includes("modules"), false);
	const prompt = buildTriagePrompt({
		messageId: "m1",
		subject: "Hi",
		from: "a@b.test",
		body: "Hello",
		instructions: "Be brief.",
		extensionInstructions: ['"modules": {"one": …}', '"modules": {"two": …}'],
	});
	const lines = prompt.system.split("\n");
	const closing = lines.indexOf(NEW_CLOSING);
	assert.deepEqual(lines.slice(closing - 2, closing), ['"modules": {"one": …}', '"modules": {"two": …}']);
	assert.equal(prompt.system.includes(OLD_CLOSING), false);
	// The mailbox preferences still come after the rules, and the email stays in the user message only.
	assert.ok(prompt.system.indexOf("Mailbox preferences") > closing);
	assert.equal(prompt.system.includes("Hello"), false);
});

test("the output cap grows by the extensions' tokens up to 200 in total, and the reasoning headroom stays", () => {
	assert.equal(MODULE_EXTENSION_MAX_OUTPUT_TOKENS, 200);
	assert.equal(extensionOutputTokens([]), 0);
	assert.equal(extensionOutputTokens([{ maxOutputTokens: 120 }]), 120);
	assert.equal(extensionOutputTokens([{ maxOutputTokens: 120 }, { maxOutputTokens: 150 }]), 200);
	const schema = buildTriageJsonSchema([{ moduleId: "one", jsonSchema: { type: "object" } }]);
	const extension = { outputTokens: 200, schema };
	const options = buildModelCallOptions({ provider: "compatible", kind: "triage", extension });
	assert.equal(options.maxOutputTokens, 600);
	assert.deepEqual(options.providerOptions.kite.response_format, {
		type: "json_schema",
		json_schema: { name: "triage", schema },
	});
	const reasoning = buildModelCallOptions({
		provider: "compatible",
		kind: "triage",
		extension,
		reasoningEffort: "low",
	});
	assert.equal(reasoning.maxOutputTokens, 1_700);
	assert.equal(buildModelCallOptions({ provider: "compatible", kind: "draft", extension }).maxOutputTokens, 900);
	// A provider without json_schema falls back to plain JSON mode with the same cap, then to none.
	const plain = fallbackOptionsAfterError(options, {
		statusCode: 400,
		message: "response_format json_schema is not supported",
	});
	assert.deepEqual(plain.providerOptions.kite, { response_format: { type: "json_object" } });
	assert.equal(plain.maxOutputTokens, 600);
	const none = fallbackOptionsAfterError(plain, { statusCode: 400, message: "response_format is not supported" });
	assert.deepEqual(none.providerOptions.kite, {});
	assert.equal(none.maxOutputTokens, 600);
});

test("modules are parsed leniently: active keys only, at most 2 KB each, never an invalid answer", () => {
	const text = (modules) => JSON.stringify({ ...benign, modules });
	const parsed = parseTriageOutput(text({ one: { a: 1 }, two: { b: 2 }, other: { c: 3 } }), new Date(), ["one", "two"]);
	assert.deepEqual(parsed.result.modules, { one: { a: 1 }, two: { b: 2 } });
	assert.equal(Object.hasOwn(parseTriageOutput(text({ one: { a: 1 } })).result, "modules"), false);
	for (const modules of ["text", 42, null, [1, 2], { other: 1 }]) {
		const outcome = parseTriageOutput(text(modules), new Date(), ["one"]);
		assert.equal(outcome.ok, true);
		assert.equal(Object.hasOwn(outcome.result, "modules"), false);
	}
	const big = parseTriageOutput(text({ one: { a: "x".repeat(2_100) }, two: "short" }), new Date(), ["one", "two"]);
	assert.deepEqual(big.result.modules, { two: "short" });
	assert.deepEqual(keepActiveModules({ one: "x".repeat(2_046) }, ["one"]), { one: "x".repeat(2_046) });
	assert.equal(keepActiveModules({ one: "x".repeat(2_047) }, ["one"]), undefined);
	assert.equal(keepActiveModules({ one: 1 }, []), undefined);
});

test("an invalid modules value never triggers the repair request", async () => {
	let calls = 0;
	const { result, calls: made } = await runTriageAttempt({
		prompt: buildTriagePrompt({ messageId: "m1", subject: "Hi", from: "a@b.test", body: "Hello" }),
		options: buildModelCallOptions({ provider: "compatible", kind: "triage" }),
		activeModuleIds: ["one"],
		generate: async () => {
			calls += 1;
			return { text: JSON.stringify({ ...benign, modules: { one: "not an object" }, extra: 1 }), finishReason: "stop" };
		},
	});
	assert.equal(made, 1);
	assert.equal(calls, 1);
	assert.deepEqual(result.modules, { one: "not an object" });
});

test("each step's model answer carries only its own module's key", () => {
	const model = { ...benign, modules: { one: { a: 1 }, two: { b: 2 } } };
	assert.deepEqual(modelForStep(model, "one"), { ...benign, modules: { one: { a: 1 } } });
	assert.deepEqual(modelForStep(model, "three"), benign);
	assert.deepEqual(modelForStep(benign, "one"), benign);
	assert.equal(modelForStep(null, "one"), null);
});

test("a hint counts only as exactly { wantsModel: true }", () => {
	assert.equal(hintSaysYes({ ok: true, output: { wantsModel: true } }), true);
	for (const result of [
		{ ok: true, output: { wantsModel: false } },
		{ ok: true, output: { wantsModel: "yes" } },
		{ ok: true, output: true },
		{ ok: false, error: { code: "timeout" } },
		null,
	])
		assert.equal(hintSaysYes(result), false);
});

// The job, end to end with the test modules.

test("a person's mail carries every active extension: merged schema, instructions, 600 tokens, own keys per step", async (t) => {
	const { db, env, raw } = await setup(t);
	setSwitches(db, { gadgets: true, widgets: true });
	const { jobId, messageId } = insertMessage(db, raw);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: null });
	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.equal(request.body.max_tokens, 600);
	assert.equal(request.body.response_format.type, "json_schema");
	assert.deepEqual(Object.keys(request.body.response_format.json_schema.schema.properties.modules.properties), [
		"extmod",
		"extbis",
	]);
	const system = systemOf(request);
	assert.ok(system.includes('"modules": {"extmod": {"gadget": name or null}}'));
	assert.ok(system.includes('"modules": {"extbis": {"widget": name or null}}'));
	assert.ok(system.endsWith(NEW_CLOSING));
	assert.equal(globalThis.__hintInputs.length, 0, "core needs the model anyway, so no hint is asked");
	assert.deepEqual(stepModel("extmod").modules, { extmod: { gadget: "Sprocket" } });
	assert.deepEqual(stepModel("extbis").modules, { extbis: { widget: "Lever" } });
	assert.ok(kindsOf(db, messageId).includes("summary"), "core plans its kinds from the model as before");
});

test("without an active extension the request is today's: json_object, 400 tokens, the original closing rule", async (t) => {
	const { db, env, raw } = await setup(t);
	setSwitches(db, { gadgets: false, widgets: false });
	const first = insertMessage(db, raw);
	await processAgentTriageJob(env, first.jobId);
	setSwitches(db, { gadgets: true, widgets: false });
	setModule(db, "extmod", false);
	const second = insertMessage(db, raw);
	await processAgentTriageJob(env, second.jobId);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.body.max_tokens, 400);
		assert.deepEqual(request.body.response_format, { type: "json_object" });
		assert.ok(systemOf(request).endsWith(OLD_CLOSING));
		assert.equal(systemOf(request).includes('"modules"'), false);
	}
	assert.deepEqual(requests[0].body, { ...requests[1].body, messages: requests[0].body.messages });
	assert.equal(systemOf(requests[0]), systemOf(requests[1]));
});

test("one active extension raises the cap by its own tokens only", async (t) => {
	const { db, env, raw } = await setup(t);
	const { jobId } = insertMessage(db, raw);
	await processAgentTriageJob(env, jobId);
	assert.equal(requests[0].body.max_tokens, 520);
	assert.deepEqual(Object.keys(requests[0].body.response_format.json_schema.schema.properties.modules.properties), [
		"extmod",
	]);
	assert.deepEqual(stepModel("extmod").modules, { extmod: { gadget: "Sprocket" } });
});

test("on the steps-only pass the hint alone asks the model, and core plans nothing from it", async (t) => {
	const { db, env, raw } = await setup(t);
	globalThis.__hintMode = "yes";
	const { jobId, messageId } = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: null });
	assert.equal(globalThis.__hintInputs.length, 1);
	assert.equal(globalThis.__hintInputs[0].model, null, "the hint runs before the model");
	assert.equal(globalThis.__hintInputs[0].facts.automatic, true);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].body.max_tokens, 520);
	assert.deepEqual(stepModel("extmod").modules, { extmod: { gadget: "Sprocket" } });
	assert.deepEqual(kindsOf(db, messageId), [], "no summary, reply or tasks from a hint-only request");
});

test("a message the model flags as suspicious gets no module card, on the full and the hint-only pass", async (t) => {
	const { db, env, raw } = await setup(t);
	globalThis.__emitCard = true;
	globalThis.__hintMode = "yes";
	const clean = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, clean.jobId);
	assert.deepEqual(kindsOf(db, clean.messageId), ["gadget_note"], "an unflagged answer keeps the card");

	answer = { ...answer, suspicious: { flagged: true, reasons: ["payment_change"] } };
	const hinted = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, hinted.jobId);
	assert.deepEqual(jobOf(db, hinted.jobId), { status: "completed", reason: null });
	assert.deepEqual(kindsOf(db, hinted.messageId), []);
	const full = insertMessage(db, raw);
	await processAgentTriageJob(env, full.jobId);
	assert.deepEqual(kindsOf(db, full.messageId), ["summary"], "a flag nothing in the mail confirms shows no warning");
	assert.deepEqual(jobOf(db, full.jobId), { status: "completed", reason: "model_flag_unconfirmed" });
	assert.equal(requests.length, 3);
});

for (const mode of ["no", "throw", "slow", "string"])
	test(`a hint that answers ${mode} adds no request`, async (t) => {
		const { db, env, raw } = await setup(t);
		globalThis.__hintMode = mode;
		const { jobId } = insertMessage(db, raw, { headers: AUTOMATIC });
		await processAgentTriageJob(env, jobId);
		assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: null });
		assert.equal(globalThis.__hintInputs.length, 1);
		assert.equal(requests.length, 0);
		assert.equal(stepModel("extmod"), null);
	});

test("muted senders and spam never get a hint-made request", async (t) => {
	const { db, env, raw } = await setup(t);
	globalThis.__hintMode = "yes";
	setSwitches(db, { gadgets: true }, { mutedSenders: ["billing@vendor.test"] });
	const muted = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, muted.jobId);
	setSwitches(db, { gadgets: true });
	const spam = insertMessage(db, raw, { headers: AUTOMATIC, spamVerdict: "spam" });
	await processAgentTriageJob(env, spam.jobId);
	assert.equal(requests.length, 0);
	assert.equal(globalThis.__hintInputs.length, 0);
});

test("a hint-only request that fails is not retried: the steps run without the model (model_failed)", async (t) => {
	const { db, env, raw } = await setup(t);
	globalThis.__hintMode = "yes";
	failWith = 500;
	const { jobId } = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: "model_failed" });
	assert.equal(requests.length, 1);
	assert.equal(stepModel("extmod"), null);
});

test("a failed model core needed is retried, and on the last attempt the steps run without it", async (t) => {
	const { db, env, raw } = await setup(t);
	failWith = 500;
	const early = insertMessage(db, raw);
	await processAgentTriageJob(env, early.jobId);
	assert.equal(jobOf(db, early.jobId).status, "pending", "requeued for another attempt");
	assert.equal(globalThis.__stepInputs.length, 0, "a retry is left, so the steps wait for it");
	const last = insertMessage(db, raw, { attempts: 2 });
	await processAgentTriageJob(env, last.jobId);
	assert.equal(globalThis.__stepInputs.length, 1);
	assert.equal(stepModel("extmod"), null);
	// A step ran, so core plans without the model and the job completes with the note.
	assert.deepEqual(jobOf(db, last.jobId), { status: "completed", reason: "model_failed" });
});

test("a last-attempt model failure still stores the deterministic phishing warning when a step ran", async (t) => {
	const { db, env, raw } = await setup(t);
	failWith = 500;
	const { jobId, messageId } = insertMessage(db, raw, { spamVerdict: "suspicious", attempts: 2 });
	await processAgentTriageJob(env, jobId);
	assert.equal(globalThis.__stepInputs.length, 1);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: "model_failed" });
	assert.deepEqual(kindsOf(db, messageId), ["phishing"]);
});

test("a last-attempt model failure with no module step fails the job as before", async (t) => {
	const { db, env, raw } = await setup(t);
	setSwitches(db, { gadgets: false, widgets: false });
	failWith = 500;
	const { jobId, messageId } = insertMessage(db, raw, { attempts: 2 });
	await processAgentTriageJob(env, jobId);
	assert.equal(globalThis.__stepInputs.length, 0);
	assert.equal(jobOf(db, jobId).status, "failed");
	assert.deepEqual(kindsOf(db, messageId), []);
});

for (const [name, options, prepare, reason] of [
	["the external opt-in is off", { externalAllowed: 0 }, () => undefined, "external_provider_not_allowed"],
	["the rate limit is exhausted", { rateLimited: true }, () => undefined, "rate_limited"],
	[
		"the spend cap is reached",
		{},
		(db) => db.db.exec("UPDATE mailbox_agent_settings SET daily_spend_cap_micros = 1 WHERE mailbox_id = 'mailbox-a'"),
		"spend_cap",
	],
])
	test(`when ${name}, a hint-made request is refused and the step runs with model null`, async (t) => {
		const { db, env, raw } = await setup(t, options);
		prepare(db);
		globalThis.__hintMode = "yes";
		const { jobId } = insertMessage(db, raw, { headers: AUTOMATIC });
		await processAgentTriageJob(env, jobId);
		assert.deepEqual(jobOf(db, jobId), { status: "completed", reason });
		assert.equal(requests.length, 0);
		assert.equal(stepModel("extmod"), null);
	});

test("the kill switch stops the job before any hint runs", async (t) => {
	const { db, env, raw } = await setup(t);
	db.db.exec("UPDATE app_settings SET agent_auto_read_enabled = 0");
	globalThis.__hintMode = "yes";
	const { jobId } = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "skipped", reason: "kill_switch" });
	assert.equal(globalThis.__hintInputs.length, 0);
	assert.equal(requests.length, 0);
});

test("the larger request is reserved in ai_usage before the call and settled after it", async (t) => {
	const { db, env, raw } = await setup(t);
	const reservations = [];
	onRequest = () =>
		reservations.push(
			db.db.prepare("SELECT cost_usd_micros AS cost FROM ai_usage WHERE reserved = 1 ORDER BY created_at DESC").get()
				?.cost,
		);
	setSwitches(db, { gadgets: false });
	await processAgentTriageJob(env, insertMessage(db, raw).jobId);
	setSwitches(db, { gadgets: true, widgets: true });
	const { jobId } = insertMessage(db, raw);
	await processAgentTriageJob(env, jobId);
	assert.equal(reservations.length, 2);
	assert.ok(reservations[1] > reservations[0], "the raised cap and longer prompt reserve more");
	const rows = db.db.prepare("SELECT source, reserved, job_id AS jobId FROM ai_usage WHERE job_id = ?").all(jobId);
	assert.deepEqual(rows, [{ source: "auto_triage", reserved: 0, jobId }]);
	const stored = JSON.stringify(db.db.prepare("SELECT * FROM ai_usage").all());
	assert.equal(stored.includes("Could you send"), false, "prompts are not persisted");
});
