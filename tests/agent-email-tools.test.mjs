import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-agent-bundle-");
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createAgentChatStream } from "./src/lib/agent/chat.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
			export { requestAgentSend } from "./src/lib/agent/approvals/utils.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as postAgentChat } from "./src/app/api/agent/chat/route.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	createAgentChatStream,
	runEmailTool,
	requestAgentSend,
	createSession,
	postAgentChat,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

test("assistant reads mail, creates an editable reply draft, and invokes tools through chat", async (t) => {
	t.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
	const directory = mkdtempSync(join(tmpdir(), "kite-agent-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(process.cwd(), "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, thread_id, created_at)
		VALUES ('email-1', 'user-1', 'mailbox-1', 'inbound', '<email-1@example.net>', 'customer@example.net', 'owner@example.com', 'Question', 'Can we meet Tuesday?', 'received', 'thread-1', 2);
	`);

	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const hasToolResult = body.messages.some((message) => message.role === "tool");
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
			);
		const drafting = JSON.stringify(body.messages).includes("Draft a reply");
		if (hasToolResult) {
			chunk({
				role: "assistant",
				content: drafting ? "I created a reply draft for review." : "I found one email in your inbox.",
			});
			chunk({}, "stop");
		} else {
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call-1",
						type: "function",
						function: drafting
							? {
									name: "draft_reply",
									arguments: '{"emailId":"email-1","body":"Tuesday works for me.","replyAll":false}',
								}
							: { name: "list_emails", arguments: '{"folder":"inbox","limit":20}' },
					},
				],
			});
			chunk({}, "tool_calls");
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	const env = {
		DB: database,
		BUCKET: { get: async () => null, delete: async () => {} },
		AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		AI_API_KEY: "test-key",
		AI_MODEL: "test-model",
	};
	const context = {
		env,
		user: { id: "user-1", email: "owner@example.com", role: "user" },
		mailboxId: "mailbox-1",
		origin: "chat",
	};

	const listed = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 20 });
	assert.equal(listed.emails[0].id, "email-1");
	const email = await runEmailTool(context, "get_email", { emailId: "email-1" });
	assert.match(email.text, /meet Tuesday/);
	const thread = await runEmailTool(context, "get_thread", { emailId: "email-1" });
	assert.equal(thread.emails.length, 1);
	const searched = await runEmailTool(context, "search_emails", { query: "Tuesday", limit: 20 });
	assert.equal(searched.emails[0].id, "email-1");
	assert.deepEqual(await runEmailTool(context, "count_emails", { folder: "inbox" }), {
		count: 1,
		folder: "inbox",
		query: null,
		unread: null,
	});
	assert.equal((await runEmailTool(context, "count_emails", { query: "Tuesday" })).count, 1);
	assert.equal(
		(await runEmailTool(context, "count_emails", { query: "from:customer@example.net", folder: "inbox", unread: true }))
			.count,
		1,
	);
	assert.equal((await runEmailTool(context, "count_emails", { query: "from:github.com" })).count, 0);
	assert.equal((await runEmailTool(context, "count_emails", { folder: "inbox", unread: false })).count, 0);
	assert.equal((await runEmailTool(context, "count_emails", { folder: "sent" })).count, 0);
	const draft = await runEmailTool(context, "draft_reply", {
		emailId: "email-1",
		body: "Tuesday works for me.",
		replyAll: false,
	});
	assert.equal(draft.status, "draft_created");
	const saved = database.db
		.prepare("SELECT to_addr, text_body, status, in_reply_to FROM messages WHERE id = ?")
		.get(draft.draftId);
	assert.equal(saved.to_addr, "customer@example.net");
	assert.equal(saved.text_body, "Tuesday works for me.");
	assert.equal(saved.status, "draft");
	assert.equal(saved.in_reply_to, "<email-1@example.net>");
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM agent_send_approvals").get().count, 0);
	const newDraft = await runEmailTool(context, "draft_email", {
		to: "customer@example.net",
		subject: "Follow up",
		body: "Hello again.",
	});
	assert.equal(database.db.prepare("SELECT status FROM messages WHERE id = ?").get(newDraft.draftId).status, "draft");
	// Chat-originated mutations only propose; confirmAgentAction re-runs them with origin "mcp".
	const approved = { ...context, origin: "mcp" };
	const discardProposal = await runEmailTool(context, "discard_draft", {
		draftId: newDraft.draftId,
		expectedRevision: 1,
	});
	assert.equal(discardProposal.status, "pending_approval");
	assert.ok(database.db.prepare("SELECT id FROM messages WHERE id = ?").get(newDraft.draftId));
	await runEmailTool(approved, "discard_draft", { draftId: newDraft.draftId, expectedRevision: 1 });
	assert.equal(database.db.prepare("SELECT id FROM messages WHERE id = ?").get(newDraft.draftId), undefined);
	const readProposal = await runEmailTool(context, "mark_email_read", { emailId: "email-1", read: true });
	assert.equal(readProposal.status, "pending_approval");
	await runEmailTool(approved, "mark_email_read", { emailId: "email-1", read: true });
	assert.equal(database.db.prepare("SELECT read FROM messages WHERE id = 'email-1'").get().read, 1);
	const moveProposal = await runEmailTool(context, "move_email", { emailId: "email-1", destination: "archived" });
	assert.equal(moveProposal.status, "pending_approval");
	assert.equal(database.db.prepare("SELECT status FROM messages WHERE id = 'email-1'").get().status, "received");
	await runEmailTool(approved, "move_email", { emailId: "email-1", destination: "archived" });
	assert.equal(database.db.prepare("SELECT status FROM messages WHERE id = 'email-1'").get().status, "archived");
	await runEmailTool(approved, "move_email", { emailId: "email-1", destination: "inbox" });

	const { stream } = await createAgentChatStream(context, "What arrived in my inbox?");
	const events = (await new Response(stream).text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(
		events.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"),
	);
	assert.ok(events.some((event) => event.type === "text" && event.text.includes("one email")));
	assert.equal(events.at(-1).type, "done");
	const drafted = await createAgentChatStream(context, "Draft a reply to email email-1");
	const draftEvents = (await new Response(drafted.stream).text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(
		draftEvents.some(
			(event) =>
				event.type === "tool" && event.name === "draft_reply" && event.state === "complete" && event.result.draftId,
		),
	);
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM agent_send_approvals").get().count, 0);
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const token = await createSession(env, "user-1");
	const request = new Request("http://kite.local/api/agent/chat", {
		method: "POST",
		headers: { Origin: "http://kite.local", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId: "mailbox-1", text: "What arrived in my inbox?" }),
	});
	const routeResponse = await postAgentChat(request);
	assert.equal(routeResponse.status, 200);
	const routeEvents = (await routeResponse.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(
		routeEvents.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"),
	);
	const bindingEnv = {
		...env,
		AI: {
			run: async (_model, input) => ({
				choices: [
					{
						message: input.messages.some((message) => message.role === "tool")
							? { role: "assistant", content: "I found one email in your inbox." }
							: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "binding-call-1",
											type: "function",
											function: { name: "list_emails", arguments: '{"folder":"inbox","limit":20}' },
										},
									],
								},
						finish_reason: input.messages.some((message) => message.role === "tool") ? "stop" : "tool_calls",
					},
				],
			}),
		},
	};
	const bindingChat = await createAgentChatStream({ ...context, env: bindingEnv }, "What arrived in my inbox?");
	const bindingEvents = (await new Response(bindingChat.stream).text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(
		bindingEvents.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"),
	);
	assert.ok(bindingEvents.some((event) => event.type === "text" && event.text.includes("one email")));
	await assert.rejects(requestAgentSend(env, context.user, draft.draftId, 2), /Draft changed/);
	const approval = await requestAgentSend(env, context.user, draft.draftId, 1);
	assert.equal(approval.status, "pending_approval");
	assert.equal(
		database.db.prepare("SELECT status FROM agent_send_approvals WHERE id = ?").get(approval.approvalId).status,
		"pending",
	);
});

test("the assistant answers once its step limit is reached", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "kite-agent-steps-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(process.cwd(), "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
	`);
	assert.equal(database.db.prepare("SELECT agent_max_steps FROM users WHERE id = 'user-1'").get().agent_max_steps, 15);

	// The mock keeps calling tools for as long as it may; honourToolChoice=false simulates a model that ignores tool_choice "none".
	let honourToolChoice = true;
	const requests = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
			);
		if (honourToolChoice && body.tool_choice === "none") {
			chunk({ role: "assistant", content: "I ran out of steps; here is what I found." });
			chunk({}, "stop");
		} else {
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: `call-${requests.length}`,
						type: "function",
						function: { name: "list_emails", arguments: '{"folder":"inbox","limit":20}' },
					},
				],
			});
			chunk({}, "tool_calls");
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const env = {
		DB: database,
		BUCKET: { get: async () => null, delete: async () => {} },
		AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
		AI_API_KEY: "test-key",
		AI_MODEL: "test-model",
	};
	const context = {
		env,
		user: { id: "user-1", email: "owner@example.com", role: "user", agentMaxSteps: 4 },
		mailboxId: "mailbox-1",
		origin: "chat",
	};

	const { stream } = await createAgentChatStream(context, "How many emails do I have?");
	const events = (await new Response(stream).text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(requests.length, 4);
	assert.equal(requests.filter((body) => body.tool_choice === "none").length, 1);
	assert.equal(requests.at(-1).tool_choice, "none");
	assert.match(JSON.stringify(requests.at(-1).messages), /last step/);
	assert.equal(events.filter((event) => event.type === "tool" && event.state === "complete").length, 3);
	assert.ok(events.some((event) => event.type === "text" && event.text.includes("ran out of steps")));
	assert.equal(events.at(-1).type, "done");

	honourToolChoice = false;
	requests.length = 0;
	const ignored = await createAgentChatStream(
		{ ...context, user: { ...context.user, agentMaxSteps: 3 } },
		"How many emails do I have?",
	);
	const ignoredEvents = (await new Response(ignored.stream).text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(requests.length, 3);
	assert.ok(ignoredEvents.some((event) => event.type === "text" && event.text.includes("step limit")));
	const saved = database.db
		.prepare("SELECT content FROM agent_chat_messages WHERE conversation_id = ? AND role = 'assistant'")
		.all(ignored.conversationId);
	assert.equal(saved.length, 1);
	assert.match(saved[0].content, /Max steps per question/);
});
