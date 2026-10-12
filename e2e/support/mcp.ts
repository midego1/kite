import { expect, type APIRequestContext } from "@playwright/test";

export type JsonRpcResponse = {
	id: number;
	result?: Record<string, unknown>;
	error?: { message: string };
};

let nextId = 1;

/** One JSON-RPC call to `/mcp` the way an MCP client makes it: bearer key, no Origin header. */
export async function mcpCall(
	api: APIRequestContext,
	key: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
	const id = nextId++;
	const response = await api.post("/mcp", {
		headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
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

export async function mcpToolNames(api: APIRequestContext, key: string): Promise<string[]> {
	const response = await mcpCall(api, key, "tools/list");
	return ((response.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort();
}

/** What a call answers, with the tool name blanked so two unknown tools compare equal. */
export function callOutcome(response: JsonRpcResponse, name: string): string {
	return JSON.stringify(response, (_key, value) =>
		typeof value === "string" ? value.split(name).join("<tool>") : value,
	).replace(/"id":\d+/, '"id":0');
}

export async function createMcpKey(
	api: APIRequestContext,
	name: string,
	scopes: string[],
	mailboxIds: string[],
): Promise<{ id: string; key: string }> {
	const response = await api.post("/api/agent/mcp-keys", { data: { name, mailboxIds, scopes } });
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as { id: string; key: string };
}
