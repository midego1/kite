import { authFetch } from "@/lib/auth/client";
import type { ConnectedMcpApp } from "./mcp-apps-settings-types";

type AppsResponse = { apps?: ConnectedMcpApp[]; migrationPending?: boolean; error?: unknown };

async function responseData(response: Response): Promise<AppsResponse> {
	return response.json<AppsResponse>().catch(() => ({}));
}

export async function loadConnectedMcpApps(): Promise<{ apps: ConnectedMcpApp[]; migrationPending: boolean }> {
	const response = await authFetch("/api/oauth/grants");
	const data = await responseData(response);
	if (!response.ok || !data.apps)
		throw new Error(typeof data.error === "string" ? data.error : "Could not load connected apps");
	return { apps: data.apps, migrationPending: !!data.migrationPending };
}

export async function disconnectMcpApp(id: string): Promise<void> {
	const response = await authFetch(`/api/oauth/grants?id=${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = await responseData(response);
		throw new Error(typeof data.error === "string" ? data.error : "Could not revoke the app");
	}
}

/** The MCP server address an OAuth client is given: this Kite's `/mcp`. */
export function mcpServerUrl(origin: string): string {
	return `${origin}/mcp`;
}
