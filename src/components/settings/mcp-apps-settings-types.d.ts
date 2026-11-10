/** An MCP app connected with OAuth, as `GET /api/oauth/grants` lists it. */
export type ConnectedMcpApp = {
	id: string;
	clientName: string;
	redirectHost: string;
	scopes: string[];
	mailboxIds: string[];
	createdAt: string;
	lastUsedAt: string | null;
};
