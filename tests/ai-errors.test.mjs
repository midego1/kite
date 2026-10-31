import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APICallError } from "@ai-sdk/provider";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-ai-errors-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		utils: fileURLToPath(import.meta.resolve("../src/lib/agent/ai-error-utils.ts")),
		reporter: fileURLToPath(import.meta.resolve("../src/lib/agent/ai-errors.ts")),
		activity: fileURLToPath(import.meta.resolve("../src/components/agent/agent-activity-utils.ts")),
		calls: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/model-call-utils.ts")),
		urls: fileURLToPath(import.meta.resolve("../src/lib/agent/provider-url-utils.ts")),
		service: fileURLToPath(import.meta.resolve("../src/lib/agent/summaries/service.ts")),
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
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const {
	aiErrorHttpStatus,
	aiErrorMessage,
	aiJobReason,
	aiReasonText,
	classifyAiError,
	modelFailedReason,
	readAiErrorBody,
	UnusableAnswerError,
} = await load("utils");
const { listRecentAiErrors, reportAiErrorClass, reportAiFailure, traceAiError } = await load("reporter");
const { reasonText } = await load("activity");
const { ModelOutputTruncatedError, TriageOutputError } = await load("calls");
const { aiCallTimeoutMs } = await load("urls");
const { createSummary, SummaryRefusal } = await load("service");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const named = (name, extra = {}) => Object.assign(new Error("x"), { name }, extra);
const apiError = (statusCode, message = "Bad request", extra = {}) =>
	new APICallError({
		message,
		url: "https://model.test/v1/chat/completions",
		requestBodyValues: {},
		statusCode,
		...extra,
	});

test("every failure kind maps to its code", () => {
	const cases = [
		[new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
		[
			Object.assign(new Error("aborted"), { name: "AbortError", cause: new DOMException("t", "TimeoutError") }),
			"timeout",
		],
		[new ModelOutputTruncatedError(), "cut_off"],
		[new TriageOutputError("not json"), "unusable_answer"],
		[new UnusableAnswerError("it was empty"), "unusable_answer"],
		[named("SpendCapReachedError"), "spend_cap"],
		[named("ChatSpendCapError"), "spend_cap"],
		[named("ExternalProviderNotAllowedError"), "external_provider_not_allowed"],
		[named("InteractiveModelRefusedError", { reason: "assistant_disabled" }), "assistant_off"],
		[named("InteractiveModelRefusedError", { reason: "not_configured" }), "no_provider"],
		[named("InteractiveModelRefusedError", { reason: "provider_key_unreadable" }), "provider_key_unreadable"],
		[named("AgentProviderKeyUnreadableError"), "provider_key_unreadable"],
		[
			named("InteractiveModelRefusedError", { reason: "external_provider_not_allowed" }),
			"external_provider_not_allowed",
		],
		[apiError(400), "provider_rejected"],
		[apiError(400, "This model's maximum context length is 8192 tokens"), "context_too_long"],
		[apiError(400, "The model `gpt-9` does not exist"), "model_unavailable"],
		[apiError(401), "provider_auth"],
		[apiError(403), "provider_auth"],
		[apiError(404), "model_unavailable"],
		[apiError(408), "timeout"],
		[apiError(413), "context_too_long"],
		[apiError(429), "provider_rate_limited"],
		[apiError(500), "provider_unavailable"],
		[apiError(503), "provider_unavailable"],
		[apiError(504), "timeout"],
		// workers-ai-provider turns a binding error into an APICallError, with a status only for codes it knows.
		[apiError(400, "5007: No such model", { data: { workersAIErrorCode: 5007 } }), "model_unavailable"],
		[apiError(undefined, "3006: Request is too large", { data: { workersAIErrorCode: 3006 } }), "context_too_long"],
		[apiError(undefined, "InferenceUpstreamError: 3010: Invalid input"), "provider_error"],
		[apiError(undefined, "Cannot connect to API: fetch failed"), "network"],
		[new TypeError("fetch failed"), "network"],
		[named("AI_RetryError", { lastError: apiError(502) }), "provider_unavailable"],
		[new Error("D1_ERROR: no such table: ai_usage"), "internal"],
		["a thrown string", "internal"],
	];
	for (const [error, code] of cases) assert.equal(classifyAiError(error).code, code, String(error?.message ?? error));
	assert.equal(classifyAiError(apiError(503)).status, 503);
	assert.equal(classifyAiError(new UnusableAnswerError("it was empty")).reason, "it was empty");
});

test("each code says what happened and what to do, with the provider's status but never its text", () => {
	assert.equal(
		aiErrorMessage("timeout", { timeoutMs: 60_000 }),
		"The AI took too long (60 s). Try again, or pick a faster model in Admin → Agent.",
	);
	assert.match(aiErrorMessage("cut_off"), /^The AI's answer was cut off/);
	assert.equal(
		aiErrorMessage("provider_rejected", { status: 400 }),
		"The AI provider refused the request (HTTP 400). Check the provider and model in Admin → Agent.",
	);
	assert.match(aiErrorMessage("provider_unavailable", { status: 503 }), /\(HTTP 503\)\. Try again in a moment\.$/);
	assert.match(aiErrorMessage("provider_auth", { status: 401 }), /API key \(HTTP 401\)/);
	assert.match(aiErrorMessage("model_unavailable"), /not available/);
	assert.equal(
		aiErrorMessage("unusable_answer", { reason: "it contained links that aren't in the email" }),
		"The AI's answer wasn't usable: it contained links that aren't in the email. Try again.",
	);
	assert.match(aiErrorMessage("spend_cap"), /spend cap/);
	assert.match(aiErrorMessage("rate_limited"), /Too many AI requests/);
	assert.match(aiErrorMessage("external_provider_not_allowed"), /not allowed the external AI provider/);
	assert.match(aiErrorMessage("assistant_off"), /turned off/);
	assert.match(aiErrorMessage("no_provider"), /No AI provider is set up/);
	assert.match(
		aiErrorMessage("provider_key_unreadable"),
		/saved API key can't be read.*enter it again in Admin → Agent/,
	);
	assert.match(aiErrorMessage("network"), /could not reach/);
	const secret = apiError(400, "Prompt was: SECRET MAIL BODY", { responseBody: '{"error":"SECRET MAIL BODY"}' });
	const failure = classifyAiError(secret);
	assert.doesNotMatch(aiErrorMessage(failure.code, failure), /SECRET/);
	assert.equal(aiErrorHttpStatus("timeout"), 504);
	assert.equal(aiErrorHttpStatus("spend_cap"), 429);
	assert.equal(aiErrorHttpStatus("assistant_off"), 403);
	assert.equal(aiErrorHttpStatus("internal"), 500);
	assert.equal(aiErrorHttpStatus("cut_off"), 502);
});

test("a client reads the code and details back, and nothing else passes for one", () => {
	const details = { code: "cut_off", feature: "summary", model: "@cf/moonshotai/kimi-k2.5", provider: "cloudflare" };
	const body = readAiErrorBody({ error: "Cut off.", code: "cut_off", details: { ...details, status: null, at: "t" } });
	assert.deepEqual(body, {
		error: "Cut off.",
		code: "cut_off",
		details: { ...details, status: null, at: "t", retryable: true, config: false },
	});
	assert.equal(readAiErrorBody({ error: "Cap", code: "spend_cap" }), null);
	assert.equal(readAiErrorBody({ error: "x", code: "provider_400", details: {} }), null);
	assert.equal(readAiErrorBody(null), null);
	assert.equal(readAiErrorBody({ error: "x", code: "no_provider", details: {} }).details.config, true);
});

test("jobs store a code that Activity puts in words, also next to module reasons", () => {
	assert.equal(aiJobReason("timeout"), "ai_error:timeout");
	assert.equal(modelFailedReason("provider_unavailable"), "model_failed:provider_unavailable");
	assert.equal(
		aiReasonText("ai_error:timeout"),
		"Failed: the AI request did not work because it took too long (timeout)",
	);
	assert.equal(aiReasonText("ai_error:nope"), null);
	assert.equal(aiReasonText("kill_switch"), null);
	assert.equal(
		reasonText("model_failed:provider_unavailable"),
		"The AI model did not answer because the provider had a problem on its side (provider_unavailable); the message was checked without it",
	);
	assert.match(reasonText("model_failed:cut_off,module_disabled:calendar"), /its answer was cut off \(cut_off\).*, /);
	assert.equal(reasonText("model_failed"), "The AI model did not answer; the message was checked without it");
});

test("the shorter test timeout applies only with the loopback flag and outside production", () => {
	const env = { AI_ALLOW_INSECURE_LOOPBACK: "1", AI_TEST_TIMEOUT_MS: "5000" };
	assert.equal(aiCallTimeoutMs(env, "development", 60_000), 5_000);
	assert.equal(aiCallTimeoutMs(env, "production", 60_000), 60_000);
	assert.equal(aiCallTimeoutMs({ AI_TEST_TIMEOUT_MS: "5000" }, "development", 60_000), 60_000);
	assert.equal(aiCallTimeoutMs({ ...env, AI_TEST_TIMEOUT_MS: "120000" }, "development", 60_000), 60_000);
	assert.equal(aiCallTimeoutMs({ ...env, AI_TEST_TIMEOUT_MS: "soon" }, "development", 60_000), 60_000);
});

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Alex Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	const env = { DB: db, AI: {} };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { db, env };
}

function captureLogs(t) {
	const lines = [];
	const original = console.warn;
	console.warn = (line) => lines.push(String(line));
	t.after(() => {
		console.warn = original;
	});
	return lines;
}

const auditRows = (db) =>
	db.db.prepare("SELECT action, actor_user_id, mailbox_id, metadata FROM audit_logs WHERE action = 'ai.error'").all();

test("a failure is logged once with its numbers, kept for Admin → Agent, and never with content", async (t) => {
	const { db, env } = await database(t);
	const logs = captureLogs(t);
	const error = apiError(503, "upstream said: SECRET MAIL BODY");
	traceAiError(error, { feature: "auto_draft", model: "draft-model", provider: "openrouter" });
	const body = await reportAiFailure(error, {
		env,
		feature: "auto_triage",
		startedAt: Date.now() - 1_500,
		usage: { inputTokens: 1200, outputTokens: 0 },
		finishReason: null,
		userId: "owner",
		mailboxId: "mailbox-a",
	});
	assert.equal(body.code, "provider_unavailable");
	assert.equal(body.error, "The AI provider had a problem on its side (HTTP 503). Try again in a moment.");
	assert.deepEqual(
		{ ...body.details, at: undefined },
		{
			code: "provider_unavailable",
			feature: "auto_draft",
			model: "draft-model",
			provider: "openrouter",
			status: 503,
			at: undefined,
			retryable: true,
			config: false,
		},
	);
	// A job rethrows what it already reported: the second report returns the same answer without a second line.
	assert.deepEqual(await reportAiFailure(error, { env, feature: "auto_triage" }), body);
	assert.equal(logs.length, 1);
	const line = JSON.parse(logs[0]);
	assert.equal(line.event, "ai.failed");
	assert.deepEqual(line.fields, {
		code: "provider_unavailable",
		feature: "auto_draft",
		model: "draft-model",
		provider: "openrouter",
		status: 503,
		durationMs: line.fields.durationMs,
		finishReason: null,
		usage: { input: 1200, output: 0 },
	});
	assert.ok(line.fields.durationMs >= 1_500);
	assert.doesNotMatch(logs.join("\n"), /SECRET/);
	const rows = auditRows(db);
	assert.equal(rows.length, 1);
	assert.doesNotMatch(rows[0].metadata, /SECRET/);
	assert.deepEqual(
		(await listRecentAiErrors(env)).map(({ id, at, durationMs, ...row }) => row),
		[
			{
				code: "provider_unavailable",
				feature: "auto_draft",
				featureLabel: "Agent draft",
				model: "draft-model",
				provider: "openrouter",
				status: 503,
				inputTokens: 1200,
				outputTokens: 0,
				finishReason: null,
				user: "owner@example.com",
				mailbox: "alex@example.com",
			},
		],
	);
});

test("only the newest 200 failures are kept, and the list shows the last 20, newest first", async (t) => {
	const { db, env } = await database(t);
	captureLogs(t);
	for (let index = 0; index < 205; index++)
		await reportAiErrorClass({ code: "provider_unavailable", status: 300 + index }, { env, feature: "chat" });
	assert.equal(auditRows(db).length, 200);
	const recent = await listRecentAiErrors(env);
	assert.equal(recent.length, 20);
	assert.equal(recent[0].status, 504);
	// A turn the person stopped is logged but not kept.
	await reportAiErrorClass({ code: "network", status: null }, { env, feature: "chat", record: false });
	assert.equal(auditRows(db).length, 200);
});

test("refusals before any provider call are never kept and logged once a minute per user, code and feature", async (t) => {
	const { db, env } = await database(t);
	const logs = captureLogs(t);
	await reportAiErrorClass({ code: "provider_unavailable", status: 503 }, { env, feature: "chat", userId: "owner" });
	const refusals = [
		"rate_limited",
		"assistant_off",
		"no_provider",
		"provider_key_unreadable",
		"external_provider_not_allowed",
		"spend_cap",
	];
	// Someone hammering the button past the rate limit: no D1 write, and the real failure stays in the list.
	for (let attempt = 0; attempt < 50; attempt++)
		for (const code of refusals) {
			const body = await reportAiErrorClass({ code, status: null }, { env, feature: "summary", userId: "spammer" });
			assert.equal(body.code, code, "the client still gets the code and message");
		}
	// Refusals are not recorded even when a caller asks for it.
	await reportAiErrorClass({ code: "rate_limited", status: null }, { env, feature: "compose", record: true });
	assert.deepEqual(
		auditRows(db).map((row) => JSON.parse(row.metadata).code),
		["provider_unavailable"],
	);
	const logged = logs.map((line) => JSON.parse(line).fields);
	assert.deepEqual(
		logged.map((fields) => `${fields.code}:${fields.feature}`),
		["provider_unavailable:chat", ...refusals.map((code) => `${code}:summary`), "rate_limited:compose"],
	);
	// Another user's refusal is logged too.
	await reportAiErrorClass({ code: "rate_limited", status: null }, { env, feature: "summary", userId: "other" });
	assert.equal(logs.length, refusals.length + 3);
});

const realFetch = globalThis.fetch;
let requests;
let reply;
beforeEach(() => {
	requests = [];
	reply = null;
});
after(() => {
	globalThis.fetch = realFetch;
});

/** An OpenAI-compatible provider that cuts an answer off at `max_tokens`, counting four characters a token. */
function provider() {
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		requests.push(body);
		if (reply === "hang")
			return new Promise((_, reject) =>
				init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
			);
		const full = reply;
		const budget = body.max_tokens * 4;
		const content = full.length > budget ? full.slice(0, budget) : full;
		return Response.json({
			id: "c",
			object: "chat.completion",
			created: 0,
			model: body.model,
			choices: [
				{ index: 0, message: { role: "assistant", content }, finish_reason: content === full ? "stop" : "length" },
			],
			usage: { prompt_tokens: 6000, completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 },
		});
	};
}

async function longThread(t) {
	const { db, env } = await database(t);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_external_auto_read_allowed = 1, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'kimi'",
		)
		.run();
	const insert = db.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'Support <help@cursor.test>', 'alex@example.com', 'Re: Team Unify blocked', ?, 'received', 'thread-x', ?)",
	);
	for (let index = 1; index <= 11; index++)
		insert.run(`m${index}`, `Message ${index}: the team plan is still blocked after payment. `.repeat(20), index);
	const user = { id: "owner", name: "Alex Owner", email: "owner@example.com", role: "admin", isPrimaryAdmin: true };
	return { db, env, user };
}

// A thorough model on a long support thread writes past the lengths the checks keep (they cut it to 400 and 200).
const LONG_SUMMARY = JSON.stringify({
	language: "en",
	overview:
		"The team plan has stayed blocked since 13 October although it was paid, and support keeps asking for details. ".repeat(
			5,
		),
	points: ["Asks", "Decisions", "Dates", "Next steps", "Asks"].map((label, index) => ({
		label,
		text: `Point ${index}: ${"support asked for the invoice number and the workspace id again before they can unblock it. ".repeat(3)}`,
	})),
});

test("an 11-message summary fits the output budget: 400 tokens cut it off, which showed as a provider error", async (t) => {
	const { db, env, user } = await longThread(t);
	captureLogs(t);
	provider();
	reply = LONG_SUMMARY;
	assert.ok(LONG_SUMMARY.length / 4 > 400, "the old 400-token budget could not hold this answer");
	const state = await createSummary(env, user, "m11", { scope: "thread", language: "en" });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].max_tokens, 1_600);
	assert.match(state.summary.overview, /^The team plan has stayed blocked.*…$/);
	assert.equal(state.summary.points.length, 5);
	assert.equal(auditRows(db).length, 0);
});

test("a summary cut off at the budget says so, with the model, tokens and finish reason logged", async (t) => {
	const { db, env, user } = await longThread(t);
	captureLogs(t);
	provider();
	reply = `{"language": "en", "overview": "${"x".repeat(8_000)}"}`;
	await assert.rejects(createSummary(env, user, "m11", { scope: "thread", language: "en" }), (error) => {
		assert.ok(error instanceof SummaryRefusal);
		assert.equal(error.status, 502);
		assert.equal(error.code, "cut_off");
		assert.match(error.message, /^The AI's answer was cut off before it was finished\./);
		assert.equal(error.details.model, "kimi");
		assert.equal(error.details.provider, "custom");
		return true;
	});
	const [row] = auditRows(db);
	assert.equal(row.actor_user_id, "owner");
	assert.equal(row.mailbox_id, "mailbox-a");
	assert.deepEqual(
		{ ...JSON.parse(row.metadata), durationMs: 0 },
		{
			code: "cut_off",
			feature: "summary",
			model: "kimi",
			provider: "custom",
			status: null,
			durationMs: 0,
			inputTokens: 6000,
			outputTokens: 1600,
			finishReason: "length",
			// The summary's own cap, kept by Why? and Ask AI; this custom provider decides thinking itself.
			budget: {
				cap: 1600,
				thinkingRoom: 0,
				extensionRoom: 0,
				thinking: "default",
				effort: null,
				retried: false,
				used: 1600,
				thinkingUsed: 0,
			},
		},
	);
});

test("a summary that times out, an unusable one and a provider error each get their own code", async (t) => {
	const { env, user } = await longThread(t);
	captureLogs(t);
	provider();
	Object.assign(env, { AI_ALLOW_INSECURE_LOOPBACK: "1", AI_TEST_TIMEOUT_MS: "50" });
	reply = "hang";
	// AbortSignal.timeout's timer does not keep Node running on its own.
	const keepAlive = setTimeout(() => undefined, 5_000);
	t.after(() => clearTimeout(keepAlive));
	await assert.rejects(createSummary(env, user, "m11", { scope: "thread", language: "en" }), (error) => {
		assert.equal(error.code, "timeout");
		assert.equal(error.status, 504);
		assert.equal(error.message, "The AI took too long (0 s). Try again, or pick a faster model in Admin → Agent.");
		return true;
	});
	reply = "Here is a summary of the conversation you asked for.";
	await assert.rejects(createSummary(env, user, "m11", { scope: "thread", language: "en" }), (error) => {
		assert.equal(error.code, "unusable_answer");
		assert.equal(error.message, "The AI's answer wasn't usable: it was not in the format Kite asked for. Try again.");
		return true;
	});
	globalThis.fetch = async () => Response.json({ error: { message: "SECRET" } }, { status: 500 });
	await assert.rejects(createSummary(env, user, "m11", { scope: "thread", language: "en" }), (error) => {
		assert.equal(error.code, "provider_unavailable");
		assert.equal(error.details.status, 500);
		assert.doesNotMatch(error.message, /SECRET/);
		return true;
	});
});
