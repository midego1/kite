import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext } from "./support/helpers";

const WRITE_TOOLS = [
	"draft_email",
	"draft_reply",
	"update_draft",
	"discard_draft",
	"mark_email_read",
	"move_email",
	"move_emails",
	"request_send",
	"get_send_request",
	"create_event",
	"update_events",
	"delete_events",
];

type JsonRpcResponse = { id: number; result?: Record<string, unknown>; error?: { message: string } };

let api: APIRequestContext;
let supportMailboxId: string;
const createdKeys: string[] = [];

async function createKey(name: string, scopes: string[]): Promise<string> {
	const response = await api.post("/api/agent/mcp-keys", { data: { name, mailboxIds: [supportMailboxId], scopes } });
	expect(response.ok(), await response.text()).toBe(true);
	const data = (await response.json()) as { id: string; key: string };
	createdKeys.push(data.id);
	return data.key;
}

let nextId = 1;
async function rpc(key: string, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
	const id = nextId++;
	const response = await api.post("/mcp", {
		headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
			// MCP clients are not browsers and send no Origin; drop the one this API context adds.
			Origin: "",
		},
		data: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
	});
	expect(response.status(), await response.text()).toBe(200);
	const body = await response.text();
	const payloads = (response.headers()["content-type"] ?? "").includes("text/event-stream")
		? body
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => JSON.parse(line.slice(5)) as JsonRpcResponse)
		: [JSON.parse(body) as JsonRpcResponse];
	const match = payloads.find((payload) => payload.id === id);
	expect(match, body).toBeDefined();
	return match!;
}

async function listToolNames(key: string): Promise<string[]> {
	const response = await rpc(key, "tools/list");
	return ((response.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
}

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	const mailboxes = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string }[];
	};
	supportMailboxId = mailboxes.mailboxes.find((mailbox) => mailbox.localPart === "support")!.id;
});

test.afterAll(async () => {
	for (const id of createdKeys) await api.delete(`/api/agent/mcp-keys?id=${id}`);
	await api.dispose();
});

test("a read-only MCP key reports the app version, lists only read tools and searches mail", async () => {
	const key = await createKey("E2E read only", ["mcp:read", "mcp:calendar-read"]);

	const init = await rpc(key, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "kite-e2e", version: "1.0.0" },
	});
	expect(init.result?.serverInfo).toMatchObject({
		name: "kite",
		version: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/),
	});

	const tools = await listToolNames(key);
	expect(tools).toEqual(
		expect.arrayContaining(["list_mailboxes", "list_emails", "get_email", "search_emails", "count_emails"]),
	);
	for (const tool of WRITE_TOOLS) expect(tools, `read-only key lists ${tool}`).not.toContain(tool);

	const search = await rpc(key, "tools/call", {
		name: "search_emails",
		arguments: { mailboxId: supportMailboxId, query: "Webhook retry question" },
	});
	expect(search.error).toBeUndefined();
	const text = ((search.result?.content ?? []) as { type: string; text: string }[]).map((part) => part.text).join("\n");
	expect(search.result?.isError).toBeFalsy();
	expect(text).toContain("Webhook retry question");

	const counted = await rpc(key, "tools/call", {
		name: "count_emails",
		arguments: { mailboxId: supportMailboxId, query: "Webhook retry question" },
	});
	expect(counted.result?.isError).toBeFalsy();
	const countText = ((counted.result?.content ?? []) as { type: string; text: string }[])
		.map((part) => part.text)
		.join("\n");
	expect((JSON.parse(countText) as { count: number }).count).toBeGreaterThanOrEqual(1);

	const blocked = await rpc(key, "tools/call", {
		name: "draft_email",
		arguments: { mailboxId: supportMailboxId, to: "x@e2e.test", subject: "no", body: "no" },
	});
	expect(blocked.error ?? blocked.result?.isError).toBeTruthy();
});

test("a key with draft scope lists the draft tools but not organise or calendar writes", async () => {
	const key = await createKey("E2E drafting", ["mcp:read", "mcp:draft"]);
	const tools = await listToolNames(key);
	expect(tools).toEqual(expect.arrayContaining(["draft_email", "draft_reply", "update_draft"]));
	for (const tool of ["mark_email_read", "move_email", "request_send", "create_event"])
		expect(tools).not.toContain(tool);
});

test("rejects requests without a valid key", async () => {
	const response = await api.post("/mcp", {
		headers: { Authorization: "Bearer not-a-real-key", Accept: "application/json, text/event-stream", Origin: "" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
	});
	expect(response.status()).toBe(401);
});
