import { createAuditLog } from "@/lib/mailboxes/audit";
import { createLogger } from "@/lib/logger.mjs";
import type { McpPrincipal } from "./types";

const log = createLogger("mcp");

/** The audit action of one MCP tool call; Admin → Audit log lists it. */
export const MCP_TOOL_CALL_ACTION = "mcp.tool_call";

type ToolOutput = { isError?: boolean };

type AuditDetails = {
	/** The mailbox the call named, kept only when the key may use it (an unknown id would break the row). */
	mailboxId?: unknown;
	/** The module that owns the tool, or the admin action (`list`, `delete`, ...). */
	moduleId?: string;
	adminAction?: unknown;
};

/**
 * Writes one audit row per MCP tool call (upstream Mailflare #225): who, which key, which tool and whether it
 * succeeded. Never arguments, results, error text or message content. A failing write is logged and never fails
 * the call.
 */
async function auditMcpToolCall(
	env: CloudflareEnv,
	principal: McpPrincipal,
	tool: string,
	outcome: "ok" | "error",
	details: AuditDetails = {},
): Promise<void> {
	const mailboxId =
		typeof details.mailboxId === "string" && principal.mailboxIds.includes(details.mailboxId)
			? details.mailboxId
			: null;
	const adminAction =
		typeof details.adminAction === "string" && /^[a-z_]{1,20}$/.test(details.adminAction) ? details.adminAction : null;
	try {
		await createAuditLog(env, {
			actorUserId: principal.user.id,
			mailboxId,
			action: MCP_TOOL_CALL_ACTION,
			metadata: {
				tool,
				keyId: principal.keyId,
				outcome,
				...(details.moduleId ? { moduleId: details.moduleId } : {}),
				...(adminAction ? { adminAction } : {}),
			},
		});
	} catch (error) {
		log.warn("mcp.audit_failed", { tool, error });
	}
}

/** Wraps a tool handler so every call, also one that throws, leaves its audit row. */
export function audited<A, R extends ToolOutput>(
	env: CloudflareEnv,
	principal: McpPrincipal,
	tool: string,
	handler: (args: A) => Promise<R>,
	details: (args: A) => AuditDetails = () => ({}),
): (args: A) => Promise<R> {
	return async (args: A) => {
		let outcome: "ok" | "error" = "error";
		try {
			const result = await handler(args);
			outcome = result.isError ? "error" : "ok";
			return result;
		} finally {
			await auditMcpToolCall(env, principal, tool, outcome, details(args));
		}
	};
}
