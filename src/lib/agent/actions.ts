import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { agentChatMessages, agentConversations, messages } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { executeAction, undoAgentAction } from "./auto-read/execute";
import { chatActionPlan, chatProposalSchema, type ChatActionAudit, type MessagePlace } from "./chat-actions-utils";
import { runEmailTool } from "./tools";

async function loadToolMessage(env: CloudflareEnv, user: SessionUser, toolMessageId: string) {
	const [row] = await getDb(env)
		.select({ message: agentChatMessages, conversation: agentConversations })
		.from(agentChatMessages)
		.innerJoin(agentConversations, eq(agentChatMessages.conversationId, agentConversations.id))
		.where(
			and(
				eq(agentChatMessages.id, toolMessageId),
				eq(agentChatMessages.role, "tool"),
				eq(agentConversations.userId, user.id),
			),
		)
		.limit(1);
	if (!row) throw new Error("Action not found");
	return row;
}

function parseContent(content: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(content);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		// Older rows were cut at 12,000 characters and can no longer be approved.
		return null;
	}
}

async function messagePlaces(env: CloudflareEnv, mailboxId: string, ids: string[]): Promise<MessagePlace[]> {
	if (ids.length === 0) return [];
	const rows = await getDb(env)
		.select({ id: messages.id, status: messages.status, folderId: messages.folderId, read: messages.read })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, ids)));
	return rows.map((row) => ({ ...row, folderId: row.folderId ?? null }));
}

/** What the audit row keeps of a tool result for Activity: counts and the folder, never message content. */
function auditAfter(audit: ChatActionAudit, result: unknown): Record<string, unknown> {
	const value = (result ?? {}) as Record<string, unknown>;
	const after: Record<string, unknown> = { count: audit.emailIds.length };
	if (typeof value.folderId === "string") after.folderId = value.folderId;
	if (typeof value.folderName === "string") after.folderName = value.folderName;
	if (audit.action === "create_folder" && typeof value.name === "string") after.folderName = value.name;
	return after;
}

/**
 * Runs an approved chat proposal. Undoable proposals go through `executeAction`, which writes the
 * `agent_actions` row before the effect (with every message's earlier state in `before`) so the change
 * shows in Activity and can be undone for the usual window; the tool result then carries the action id.
 */
async function applyProposal(
	env: CloudflareEnv,
	user: SessionUser,
	mailboxId: string,
	plan: ReturnType<typeof chatActionPlan>,
): Promise<{ result: unknown; actionId?: string; undoUntil?: string | null }> {
	const folderId = plan.audit?.action === "create_folder" ? newId("fld") : undefined;
	const context = { env, user, mailboxId, origin: "mcp" as const, folderId };
	if (!plan.audit) return { result: await runEmailTool(context, plan.tool, plan.input) };
	const audit = plan.audit;
	const access = await getMailboxAccessLevel(getDb(env), user, mailboxId);
	if (!access?.canRead) throw new Error("Mailbox not found or permission denied");
	const places = await messagePlaces(env, mailboxId, audit.emailIds);
	let result: unknown = null;
	const outcome = await executeAction({
		env,
		mailboxId,
		// A message deleted since the proposal is left out: the row's message reference must exist.
		messageId: places[0]?.id ?? null,
		action: audit.action,
		variant: audit.variant,
		actingUserId: user.id,
		initiator: "user",
		permissions: access,
		effect: {
			...(folderId ? { ids: { folderId } } : {}),
			before: { messages: places },
			async apply() {
				result = await runEmailTool(context, plan.tool, plan.input);
				return auditAfter(audit, result);
			},
		},
	});
	if (outcome.status !== "applied")
		throw new Error(
			outcome.reason?.startsWith("missing_")
				? "Mailbox not found or permission denied"
				: outcome.reason || "Action failed",
		);
	const [row] = await getDb(env)
		.select({ undoUntil: agentActions.undoUntil })
		.from(agentActions)
		.where(eq(agentActions.id, outcome.actionId))
		.limit(1);
	return { result, actionId: outcome.actionId, undoUntil: row?.undoUntil?.toISOString() ?? null };
}

export async function confirmAgentAction(env: CloudflareEnv, user: SessionUser, toolMessageId: string) {
	const db = getDb(env);
	const row = await loadToolMessage(env, user, toolMessageId);
	const stored = parseContent(row.message.content);
	const proposal = chatProposalSchema.safeParse(stored);
	if (!proposal.success || row.message.toolName !== proposal.data.action)
		throw new Error("Action is unavailable or already approved");
	const claimed = await db
		.update(agentChatMessages)
		.set({ content: JSON.stringify({ ...stored, status: "processing" }) })
		.where(and(eq(agentChatMessages.id, toolMessageId), eq(agentChatMessages.content, row.message.content)))
		.returning({ id: agentChatMessages.id });
	if (!claimed.length) throw new Error("Action is already being processed");
	try {
		const applied = await applyProposal(env, user, row.conversation.mailboxId, chatActionPlan(proposal.data));
		const updated = { ...stored, status: "approved", ...applied };
		await db
			.update(agentChatMessages)
			.set({ content: JSON.stringify(updated) })
			.where(eq(agentChatMessages.id, toolMessageId));
		return updated;
	} catch (error) {
		await db
			.update(agentChatMessages)
			.set({ content: row.message.content })
			.where(eq(agentChatMessages.id, toolMessageId));
		throw error;
	}
}

/**
 * Undoes an approved chat action through the audit row it wrote, with the same rules as Undo in Activity,
 * and marks the chat result `undone`. An action already undone elsewhere (from Activity) only updates the chat.
 */
export async function undoChatAgentAction(env: CloudflareEnv, user: SessionUser, toolMessageId: string) {
	const db = getDb(env);
	const row = await loadToolMessage(env, user, toolMessageId);
	const stored = parseContent(row.message.content);
	const actionId = stored?.status === "approved" && typeof stored.actionId === "string" ? stored.actionId : null;
	if (!stored || !actionId) throw new Error("This action cannot be undone");
	const [action] = await db
		.select({ status: agentActions.status })
		.from(agentActions)
		.where(eq(agentActions.id, actionId))
		.limit(1);
	if (action?.status !== "undone") await undoAgentAction(env, user, actionId);
	const updated = { ...stored, status: "undone" };
	await db
		.update(agentChatMessages)
		.set({ content: JSON.stringify(updated) })
		.where(and(eq(agentChatMessages.id, toolMessageId), eq(agentChatMessages.content, row.message.content)));
	return updated;
}
