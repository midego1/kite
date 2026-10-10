import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	DRAFT_SYSTEM_MARKER,
	REPAIR_MARKER,
	TRIAGE_SYSTEM_MARKER,
} from "../../src/lib/agent/auto-read/request-markers";
import { FAKE_SCENARIOS, scenarioReply } from "./fake-model-scenarios";
import type {
	FakeModel,
	FakeModelOptions,
	FakeModelReply,
	FakeRecordedRequest,
	FakeRequestKind,
} from "./fake-model-types";

type ChatMessage = { role?: unknown; content?: unknown };
type ChatBody = { model?: unknown; messages?: unknown };

const SCENARIO_MARKER = /\[\[scenario:([\w-]+)\]\]/g;
const EMAIL_ID = /<<<EMAIL id=([^\s>]+)/;
const FAKE_MODELS = ["fake-triage", "fake-draft"];

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

function chatMessages(body: ChatBody): ChatMessage[] {
	return Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
}

function classifyFakeRequest(messages: ChatMessage[]): FakeRequestKind {
	if (messages.some((message) => messageText(message).includes(REPAIR_MARKER))) return "repair";
	const system = messages
		.filter((message) => message.role === "system")
		.map(messageText)
		.join("\n");
	if (system.includes(TRIAGE_SYSTEM_MARKER)) return "triage";
	if (system.includes(DRAFT_SYSTEM_MARKER)) return "draft";
	return "other";
}

/** The marker in the latest message that has one; later markers in the same message win. */
function scenarioMarker(messages: ChatMessage[]): string | null {
	for (const message of [...messages].reverse()) {
		const names = [...messageText(message).matchAll(SCENARIO_MARKER)].map((match) => match[1]);
		if (names.length) return names[names.length - 1];
	}
	return null;
}

function emailIdOf(messages: ChatMessage[]): string | null {
	for (const message of messages) {
		const match = messageText(message).match(EMAIL_ID);
		if (match) return match[1];
	}
	return null;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

function parseJson(raw: string): unknown {
	try {
		return raw ? JSON.parse(raw) : null;
	} catch {
		return raw;
	}
}

const tokens = (value: string) => Math.max(1, Math.ceil(value.length / 4));

function completion(id: number, body: ChatBody, reply: FakeModelReply, promptChars: number) {
	const content = reply.content ?? "";
	const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
	const completionTokens = tokens(content);
	return {
		id: `chatcmpl-fake-${id}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: typeof body.model === "string" ? body.model : FAKE_MODELS[0],
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: reply.finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

/**
 * A loopback OpenAI-compatible model for specs and manual validation. The reply is picked by a
 * `[[scenario:<name>]]` marker in the request messages (or the queue / default scenario), shaped
 * for the request type the prompt markers in `request-markers.ts` announce.
 */
export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
	const recorded: FakeRecordedRequest[] = [];
	const calls = new Map<string, number>();
	const queue: string[] = [];
	const slowMs = options.slowMs ?? 20_000;
	let defaultScenario = "default";
	let nextId = 1;

	function record(request: IncomingMessage, path: string, fields: Partial<FakeRecordedRequest>) {
		const entry: FakeRecordedRequest = {
			id: nextId++,
			receivedAt: new Date().toISOString(),
			method: request.method ?? "GET",
			path,
			kind: null,
			scenario: null,
			emailId: null,
			body: null,
			...fields,
		};
		recorded.push(entry);
		return entry;
	}

	async function chat(request: IncomingMessage, response: ServerResponse, path: string) {
		const raw = await readBody(request);
		const parsed = parseJson(raw);
		const body = (parsed && typeof parsed === "object" ? parsed : {}) as ChatBody;
		const messages = chatMessages(body);
		const kind = classifyFakeRequest(messages);
		const marker = queue.shift() ?? scenarioMarker(messages);
		const scenario = marker && FAKE_SCENARIOS[marker] ? marker : defaultScenario;
		const emailId = emailIdOf(messages);
		const callKey = `${kind}:${emailId ?? messageText(messages[messages.length - 1] ?? {})}`;
		const callNumber = (calls.get(callKey) ?? 0) + 1;
		calls.set(callKey, callNumber);
		const entry = record(request, path, { kind, scenario, emailId, body: parsed });
		const reply = scenarioReply(FAKE_SCENARIOS[scenario], kind, { callNumber, slowMs });
		if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
		if (reply.status && reply.status >= 400)
			return sendJson(response, reply.status, {
				error: { message: `Fake model failure (${scenario})`, type: "server_error", code: reply.status },
			});
		sendJson(response, 200, completion(entry.id, body, reply, messages.map(messageText).join("").length));
	}

	async function scenarioControl(request: IncomingMessage, response: ServerResponse) {
		if (request.method === "DELETE") defaultScenario = "default";
		if (request.method === "POST") {
			const name = (parseJson(await readBody(request)) as { name?: unknown } | null)?.name;
			if (typeof name !== "string" || !FAKE_SCENARIOS[name])
				return sendJson(response, 400, { error: "Unknown scenario", scenarios: Object.keys(FAKE_SCENARIOS) });
			defaultScenario = name;
		}
		sendJson(response, 200, { defaultScenario, scenarios: Object.keys(FAKE_SCENARIOS) });
	}

	function requestsControl(request: IncomingMessage, response: ServerResponse) {
		if (request.method === "DELETE") {
			recorded.length = 0;
			calls.clear();
		}
		sendJson(response, 200, { requests: recorded });
	}

	async function route(request: IncomingMessage, response: ServerResponse) {
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/v1(?=\/)/, "");
		if (path === "/__fake/requests") return requestsControl(request, response);
		if (path === "/__fake/scenario") return scenarioControl(request, response);
		if (path === "/models" && request.method === "GET") {
			record(request, path, {});
			return sendJson(response, 200, {
				object: "list",
				data: FAKE_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "kite-fake" })),
			});
		}
		if (path === "/chat/completions" && request.method === "POST") return chat(request, response, path);
		sendJson(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
	}

	const server = createServer((request, response) => {
		route(request, response).catch((error: unknown) => {
			if (!response.headersSent) sendJson(response, 500, { error: { message: String(error) } });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		port,
		requests: () => [...recorded],
		clearRequests: () => {
			recorded.length = 0;
			calls.clear();
		},
		setDefaultScenario: (name) => {
			if (!FAKE_SCENARIOS[name]) throw new Error(`Unknown fake model scenario: ${name}`);
			defaultScenario = name;
		},
		resetDefaultScenario: () => {
			defaultScenario = "default";
		},
		enqueueScenario: (...names) => {
			queue.push(...names);
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
