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

/** The `before` an approved chat action saves: the marker, each message before the effect and right after it. */
export type ChatActionState = { source: "chat"; messages: MessagePlace[]; applied: MessagePlace[] };

/** How many messages an undo put back, of those the action had changed. */
export type UndoCounts = { restored: number; total: number };
