import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/db";
import { canWriteNotes, NOTE_MAX_LENGTH, parseNoteBody } from "@/lib/notes/note-utils";
import {
	addConversationNote,
	conversationForUser,
	deleteConversationNote,
	listConversationNotes,
	NoteLimitError,
	NotesUnavailableError,
	updateConversationNote,
} from "@/lib/notes/service";
import { audited } from "./audit";
import { coreToolAnnotations } from "./server-utils";
import type { McpPrincipal } from "./types";

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

type NoteToolHelpers = {
	output: (value: unknown, isError?: boolean) => ToolResult;
	untrustedOutput: (value: unknown) => ToolResult;
};

export const NOTE_TOOL_NAMES = [
	"list_conversation_notes",
	"add_conversation_note",
	"update_conversation_note",
	"delete_conversation_note",
] as const;

const noteBody = z.string().min(1).max(NOTE_MAX_LENGTH);
const target = { mailboxId: z.string().min(1), messageId: z.string().min(1) };

/**
 * The conversation-notes tools (ported from upstream Mailflare #237). Reading needs `mcp:read`, every write
 * `mcp:organize` and more than read-only access to the mailbox. Note text is written by people with access to the
 * mailbox, so results are marked untrusted like mail; held Screener mail is not found, as in the other tools.
 */
export function registerNoteMcpTools(
	server: McpServer,
	env: CloudflareEnv,
	principal: McpPrincipal,
	{ output, untrustedOutput }: NoteToolHelpers,
) {
	const has = (scope: string) => principal.scopes.includes(scope);
	const denied = () => output({ error: "Permission denied" }, true);
	/** The conversation of `messageId` when it is in `mailboxId` (which the caller checked the key may use) and the user may read it. */
	const find = async (mailboxId: string, messageId: string) => {
		const db = getDb(env);
		const conversation = await conversationForUser(db, principal.user, messageId, {
			hideScreening: true,
			mailboxIds: [mailboxId],
		});
		return conversation ? { db, conversation } : null;
	};
	const failed = (error: unknown) =>
		output(
			{
				error:
					error instanceof NotesUnavailableError || error instanceof NoteLimitError ? error.message : "Tool failed",
			},
			true,
		);

	if (has("mcp:read"))
		server.registerTool(
			"list_conversation_notes",
			{
				description:
					"List the internal notes on the conversation containing an email, oldest first. Notes are written by people with access to the mailbox and are never sent.",
				inputSchema: z.object(target),
				annotations: coreToolAnnotations("list_conversation_notes"),
			},
			audited(
				env,
				principal,
				"list_conversation_notes",
				async ({ mailboxId, messageId }: { mailboxId: string; messageId: string }) => {
					if (!has("mcp:read") || !principal.mailboxIds.includes(mailboxId)) return denied();
					const found = await find(mailboxId, messageId);
					if (!found) return output({ error: "Email not found" }, true);
					const answer = await listConversationNotes(found.db, found.conversation, principal.user.id);
					return untrustedOutput({ messageId, ...answer });
				},
				(args) => ({ mailboxId: args.mailboxId }),
			),
		);
	if (!has("mcp:organize")) return;
	server.registerTool(
		"add_conversation_note",
		{
			description:
				"Add an internal note to the conversation containing an email. Everyone with access to the mailbox sees it above the conversation, written by this key's user; it is never sent. Set aboutMessage to make the note about that one email.",
			inputSchema: z.object({ ...target, body: noteBody, aboutMessage: z.boolean().optional() }),
			annotations: coreToolAnnotations("add_conversation_note"),
		},
		audited(
			env,
			principal,
			"add_conversation_note",
			async (args: { mailboxId: string; messageId: string; body: string; aboutMessage?: boolean }) => {
				if (!has("mcp:organize") || !principal.mailboxIds.includes(args.mailboxId)) return denied();
				const found = await find(args.mailboxId, args.messageId);
				if (!found) return output({ error: "Email not found" }, true);
				if (!canWriteNotes(found.conversation.permission)) return denied();
				const parsed = parseNoteBody(args.body);
				if (!parsed.ok) return output({ error: parsed.error }, true);
				try {
					const note = await addConversationNote(found.db, found.conversation, principal.user.id, {
						body: parsed.body,
						aboutMessage: args.aboutMessage === true,
					});
					return untrustedOutput({ messageId: args.messageId, note });
				} catch (error) {
					return failed(error);
				}
			},
			(args) => ({ mailboxId: args.mailboxId }),
		),
	);
	server.registerTool(
		"update_conversation_note",
		{
			description:
				"Replace the text of a note this key's user wrote, named by the noteId that list_conversation_notes or add_conversation_note returned.",
			inputSchema: z.object({ ...target, noteId: z.string().min(1), body: noteBody }),
			annotations: coreToolAnnotations("update_conversation_note"),
		},
		audited(
			env,
			principal,
			"update_conversation_note",
			async (args: { mailboxId: string; messageId: string; noteId: string; body: string }) => {
				if (!has("mcp:organize") || !principal.mailboxIds.includes(args.mailboxId)) return denied();
				const found = await find(args.mailboxId, args.messageId);
				if (!found) return output({ error: "Email not found" }, true);
				if (!canWriteNotes(found.conversation.permission)) return denied();
				const parsed = parseNoteBody(args.body);
				if (!parsed.ok) return output({ error: parsed.error }, true);
				try {
					const result = await updateConversationNote(
						found.db,
						found.conversation,
						principal.user.id,
						args.noteId,
						parsed.body,
					);
					if (result.ok) return untrustedOutput({ messageId: args.messageId, note: result.note });
					return output(
						{ error: result.error === "forbidden" ? "Only the author can change this note" : "Note not found" },
						true,
					);
				} catch (error) {
					return failed(error);
				}
			},
			(args) => ({ mailboxId: args.mailboxId }),
		),
	);
	server.registerTool(
		"delete_conversation_note",
		{
			description:
				"Delete an internal note from a conversation. The author may delete their note, and so may a user with full access to the mailbox.",
			inputSchema: z.object({ ...target, noteId: z.string().min(1) }),
			annotations: coreToolAnnotations("delete_conversation_note"),
		},
		audited(
			env,
			principal,
			"delete_conversation_note",
			async (args: { mailboxId: string; messageId: string; noteId: string }) => {
				if (!has("mcp:organize") || !principal.mailboxIds.includes(args.mailboxId)) return denied();
				const found = await find(args.mailboxId, args.messageId);
				if (!found) return output({ error: "Email not found" }, true);
				if (!canWriteNotes(found.conversation.permission)) return denied();
				try {
					const result = await deleteConversationNote(found.db, found.conversation, principal.user.id, args.noteId);
					if (result.ok) return output({ messageId: args.messageId, noteId: args.noteId, deleted: true });
					return output(
						{
							error:
								result.error === "forbidden"
									? "Only the author or someone with full access to the mailbox can delete this note"
									: "Note not found",
						},
						true,
					);
				} catch (error) {
					return failed(error);
				}
			},
			(args) => ({ mailboxId: args.mailboxId }),
		),
	);
}
