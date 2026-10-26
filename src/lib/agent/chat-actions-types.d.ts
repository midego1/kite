import type { EmailToolName } from "./types";

/** How an approved proposal is recorded in `agent_actions`; null for an action that is not undoable. */
export type ChatActionAudit = {
	action: "move" | "mark_read" | "set_folder" | "create_folder";
	variant: string;
	emailIds: string[];
};

export type ChatActionPlan = { tool: EmailToolName; input: Record<string, unknown>; audit: ChatActionAudit | null };

/** One message as it was before an approved chat action changed it. */
export type MessagePlace = { id: string; status: string; folderId: string | null; read: boolean };
