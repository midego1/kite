import { and, count, desc, eq, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentDraftMetadata, domains, mailboxes, messages } from "@/db/schema";
import { buildSnippet } from "@/lib/email/parse";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { buildReplyReferences, formatMessageIdHeader, parseMessageIdList } from "@/lib/email/threading";
import { buildSearchConditions } from "@/lib/search/conditions";
import { viaSearchAvailable } from "@/lib/external-accounts/via";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { newId } from "@/lib/ids";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { listMessageAttachments } from "@/lib/email/attachments";
import { loadMessageBodies, loadMessageBody } from "@/lib/email/bodies";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import type { AgentToolContext, EmailToolName } from "./types";
import { getReplyRecipients } from "./reply";
import { formatAgentDraftBody } from "./draft-format";
import { editAgentDraft } from "./edit-draft";
import { requestAgentSend } from "./approvals/utils";
import type { AgentDraftEditInput } from "./types";
import { toolEmailSchema } from "./tool-schema-utils";
import { ownMessage, publicMessage, requireAccess } from "./tool-messages";
import { isOrganizeTool, runOrganizeTool } from "./organize-tools";
import { FOLDER_COLOR_NAMES } from "./organize-tools-utils";
import { currentThreadSummary } from "./summaries/service";
import { agentThreadRows } from "./thread-context";

const id = z.string().min(1).max(160);
const body = z
	.string()
	.trim()
	.min(1)
	.max(40_000)
	.describe("The recipient-facing email body as ordinary prose. Do not use Markdown or HTML formatting.");
const limit = z.number().int().min(1).max(50).default(20);
const folder = z.enum(["inbox", "sent", "draft", "archived", "trash", "spam"]);
/** Bulk organize tools take at most 20 emails per call, so one approval never covers more than that. */
const emailIds = z
	.array(id)
	.min(1)
	.max(20)
	.describe("Up to 20 email IDs from list_emails or search_emails in this mailbox.");

export const emailToolSchemas = {
	list_emails: z.object({
		folder: folder.default("inbox"),
		limit,
		cursor: id
			.nullish()
			.describe(
				"Omit or set to null for the first page. For later pages, pass only the exact nextCursor returned by list_emails for this mailbox and folder. Stop when nextCursor is null. Never invent a cursor or use a page number or offset such as '0'.",
			),
	}),
	get_email: z.object({ emailId: id }),
	get_thread: z.object({ emailId: id }),
	search_emails: z.object({ query: z.string().trim().min(1).max(300), folder: folder.optional(), limit }),
	count_emails: z.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.optional()
			.describe(
				"Optional search query using the same syntax as search_emails, for example from:github.com or subject:invoice.",
			),
		folder: folder.optional().describe("Folder to count in. Omit to count across all folders."),
		unread: z.boolean().optional().describe("true counts only unread emails, false only read ones."),
	}),
	draft_email: z.object({ to: toolEmailSchema, subject: z.string().trim().min(1).max(500), body }),
	draft_reply: z.object({ emailId: id, body, replyAll: z.boolean().default(false) }),
	edit_draft: z.object({
		draftId: id,
		expectedRevision: z.number().int().positive(),
		from: z.string().max(320).optional(),
		to: z.string().max(2_000).optional(),
		cc: z.string().max(2_000).nullable().optional(),
		bcc: z.string().max(2_000).nullable().optional(),
		subject: z.string().max(500).optional(),
		body: z.string().max(40_000).optional(),
		scheduledAt: z.string().max(40).nullable().optional(),
		addAttachments: z
			.array(z.object({ sourceEmailId: id, attachmentId: id }))
			.max(10)
			.optional(),
		removeAttachmentIds: z.array(id).max(10).optional(),
	}),
	review_draft_send: z.object({ draftId: id, expectedRevision: z.number().int().positive() }),
	mark_email_read: z.object({ emailId: id, read: z.boolean() }),
	mark_emails_read: z.object({ emailIds }),
	mark_emails_unread: z.object({ emailIds }),
	move_email: z.object({ emailId: id, destination: z.enum(["inbox", "archived", "trash", "spam"]) }),
	move_emails: z.object({
		emailIds,
		destination: z.enum(["inbox", "archived", "trash", "spam"]),
	}),
	list_folders: z.object({}),
	create_folder: z.object({
		name: z.string().trim().min(1).max(80),
		color: z.enum(FOLDER_COLOR_NAMES).optional().describe("Folder colour; blue when omitted."),
	}),
	move_emails_to_folder: z.object({
		emailIds,
		folderId: id.describe("A folderId returned by list_folders."),
	}),
	discard_draft: z.object({ draftId: id, expectedRevision: z.number().int().positive() }),
} as const;

/** These descriptions serve chat and MCP alike, so they say where the approval applies. */
const APPROVAL_NOTE =
	"In the Kite assistant chat this only proposes the change, the user approves it in Kite and can undo it there; over MCP it applies at once.";

export const emailToolDescriptions: Record<EmailToolName, string> = {
	list_emails:
		"List email metadata in a mailbox folder with pagination. Omit cursor or set it to null for the first page; use the returned nextCursor for later pages.",
	get_email: "Read one email and its attachment metadata without marking it read.",
	get_thread: "Read the recent conversation containing an email before drafting a reply.",
	search_emails: "Search email subject and body in this mailbox.",
	count_emails:
		'Count emails in this mailbox matching an optional search query, folder, and read state with one exact database count. Use this for any "how many" question instead of listing or searching and counting results yourself.',
	draft_email: "Save a new email draft. This never sends.",
	draft_reply: "Save a reply draft with recipients and threading derived from the source email. This never sends.",
	edit_draft:
		"Update a draft created by the assistant in the selected mailbox. First read it with get_email to get its current revision and attachment IDs. Can change sender, recipients, subject, body, requested schedule, and copy or remove attachments from accessible emails. Use an ISO 8601 send time with timezone offset; null clears it. This never sends or schedules delivery by itself.",
	review_draft_send:
		"Create a review link for the current assistant draft revision. The user must explicitly confirm before the email is sent or scheduled. This tool never sends or queues an email.",
	mark_email_read: "Mark one email as read or unread. For several emails use mark_emails_read or mark_emails_unread.",
	mark_emails_read: `Mark up to 20 emails as read. ${APPROVAL_NOTE}`,
	mark_emails_unread: `Mark up to 20 emails as unread. ${APPROVAL_NOTE}`,
	move_email: "Move an email to inbox, archive, trash, or spam.",
	move_emails: `Archive, trash, mark as spam, or move back to the inbox up to 20 emails at once. To clean up mail matching a search, call search_emails first and pass up to 20 of the returned IDs; for more, handle one batch before proposing the next. Trash is not permanent deletion. Needs full access to the mailbox; drafts and sent mail cannot be moved. ${APPROVAL_NOTE}`,
	list_folders: "List the user-created folders of this mailbox with their folderId, name, and color.",
	create_folder: `Create a folder in this mailbox. Needs full access to the mailbox. ${APPROVAL_NOTE} A proposed folder exists only once approved; then call list_folders for its folderId.`,
	move_emails_to_folder: `File up to 20 emails into one of this mailbox's folders (folderId from list_folders). Filed mail leaves the inbox, archive, trash, or spam. Needs full access to the mailbox; drafts and sent mail cannot be moved. ${APPROVAL_NOTE}`,
	discard_draft: "Discard an unedited agent draft by ID and revision.",
};

export const EMAIL_TOOL_NAMES = Object.keys(emailToolSchemas) as EmailToolName[];

const INVALID_CURSOR_MESSAGE =
	"Invalid pagination cursor. To start from the first page, omit cursor or set it to null. For later pages, use only the nextCursor returned by list_emails for this mailbox and folder; never invent a cursor or use a page number or offset.";

async function createDraft(
	context: AgentToolContext,
	input: { to: string; cc?: string; subject: string; body: string; source?: typeof messages.$inferSelect },
) {
	await requireAccess(context, true);
	const formattedBody = formatAgentDraftBody(input.body);
	if (!formattedBody.text) throw new Error("Draft body is empty");
	const db = getDb(context.env);
	const [mailbox] = await db
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, context.mailboxId))
		.limit(1);
	if (!mailbox) throw new Error("Mailbox not found");
	const sender = await getAuthorizedSenderAddress(context.env, {
		userId: context.user.id,
		mailboxId: context.mailboxId,
		from: `${mailbox.localPart}@${mailbox.hostname}`,
	});
	const source = input.source;
	const references = source
		? buildReplyReferences(parseMessageIdList(source.references), source.providerMessageId)
		: [];
	const draftId = context.draftId ?? newId("msg");
	await db.insert(messages).values({
		id: draftId,
		userId: context.user.id,
		mailboxId: context.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to,
		ccAddr: input.cc || null,
		subject: input.subject,
		textBody: formattedBody.text,
		htmlBody: formattedBody.html,
		snippet: buildSnippet(formattedBody.text, null),
		status: "draft",
		read: true,
		inReplyTo: source?.providerMessageId ?? null,
		references: references.length ? formatMessageIdHeader(references) : null,
		threadId: source?.threadId ?? null,
	});
	try {
		await db
			.insert(agentDraftMetadata)
			.values({ draftId, mailboxId: context.mailboxId, origin: context.origin, sourceMessageId: source?.id ?? null });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, draftId));
		throw error;
	}
	return {
		draftId,
		revision: 1,
		sourceMessageId: source?.id ?? null,
		status: "draft_created",
		composerUrl: `/drafts/${draftId}`,
	};
}

function mailboxFolderConditions(context: AgentToolContext, folder: string | undefined): SQL[] {
	const conditions: SQL[] = [eq(messages.mailboxId, context.mailboxId)];
	if (folder === "draft") conditions.push(eq(messages.status, "draft"), eq(messages.userId, context.user.id));
	else if (folder === "sent") conditions.push(eq(messages.status, "sent"));
	else if (folder === "inbox") conditions.push(eq(messages.status, "received"), isNull(messages.folderId));
	else if (folder === "archived" || folder === "trash" || folder === "spam")
		conditions.push(eq(messages.status, folder));
	else
		conditions.push(
			or(eq(messages.userId, context.user.id), eq(messages.direction, "inbound"))!,
			ne(messages.status, SCREENING_STATUS),
		);
	return conditions;
}

/** The search grammar's conditions; `via:` matches nothing before the connected-account tables exist. */
async function searchConditions(context: AgentToolContext, query: string): Promise<SQL[]> {
	return buildSearchConditions(query, context.timeZone ?? "UTC", {
		connectedAccounts: await viaSearchAvailable(context.env, query),
	});
}

export async function runEmailTool(
	context: AgentToolContext,
	name: EmailToolName,
	rawInput: unknown,
): Promise<unknown> {
	const input = emailToolSchemas[name].parse(rawInput) as Record<string, unknown>;
	if (isOrganizeTool(name)) return runOrganizeTool(context, name, input);
	const db = getDb(context.env);
	if (name === "count_emails") {
		await requireAccess(context);
		const conditions = mailboxFolderConditions(context, input.folder as string | undefined);
		if (input.query) conditions.push(...(await searchConditions(context, input.query as string)));
		if (typeof input.unread === "boolean") conditions.push(eq(messages.read, !input.unread));
		const [row] = await db
			.select({ value: count() })
			.from(messages)
			.where(and(...conditions));
		return {
			count: row?.value ?? 0,
			folder: input.folder ?? "all",
			query: input.query ?? null,
			unread: input.unread ?? null,
		};
	}
	if (name === "list_emails" || name === "search_emails") {
		await requireAccess(context);
		const conditions = mailboxFolderConditions(context, input.folder as string | undefined);
		if (name === "search_emails") conditions.push(...(await searchConditions(context, input.query as string)));
		if (input.cursor) {
			const cursor = await ownMessage(context, input.cursor as string, INVALID_CURSOR_MESSAGE);
			conditions.push(lt(messages.createdAt, cursor.createdAt));
		}
		const pageSize = input.limit as number;
		const rows = await db
			.select()
			.from(messages)
			.where(and(...conditions))
			.orderBy(desc(messages.createdAt))
			.limit(pageSize + 1);
		return {
			emails: rows.slice(0, pageSize).map(publicMessage),
			nextCursor: rows.length > pageSize ? rows[pageSize - 1]?.id : null,
		};
	}
	if (name === "get_email") {
		const row = await loadMessageBody(context.env, await ownMessage(context, input.emailId as string));
		const attachments = await listMessageAttachments(context.env, row.id);
		const text = (row.textBody || htmlToReadableText(row.htmlBody)).slice(0, 30_000);
		const [metadata] =
			row.status === "draft"
				? await db
						.select({ revision: agentDraftMetadata.revision, scheduledAt: agentDraftMetadata.scheduledAt })
						.from(agentDraftMetadata)
						.where(eq(agentDraftMetadata.draftId, row.id))
						.limit(1)
				: [];
		return {
			...publicMessage(row),
			...(row.status === "draft"
				? {
						bcc: row.bccAddr,
						revision: metadata?.revision ?? null,
						scheduledAt: metadata?.scheduledAt?.toISOString() ?? null,
					}
				: {}),
			text,
			truncated: (row.textBody || row.htmlBody || "").length > 30_000,
			attachments: attachments.map(({ id, filename, size, type }) => ({ id, filename, size, contentType: type })),
		};
	}
	if (name === "get_thread") {
		const anchor = await ownMessage(context, input.emailId as string);
		const stored = await agentThreadRows(context.env, {
			mailboxId: context.mailboxId,
			anchor,
			viewerId: context.user.id,
			limit: 21,
		});
		const rows = await loadMessageBodies(context.env, stored, { textFirst: true });
		return {
			emails: rows
				.slice(0, 20)
				.reverse()
				.map((row) => ({
					...publicMessage(row),
					text: (row.textBody || htmlToReadableText(row.htmlBody)).slice(0, 5_000),
				})),
			truncated: rows.length > 20,
			// The cached conversation summary when it is current, so the assistant can answer from it.
			summary: await currentThreadSummary(context.env, context.user, anchor.id),
		};
	}
	if (name === "draft_email")
		return createDraft(context, {
			to: input.to as string,
			subject: input.subject as string,
			body: input.body as string,
		});
	if (name === "draft_reply") {
		const source = await ownMessage(context, input.emailId as string);
		if (source.direction !== "inbound" || source.status === "spam" || source.status === "trash")
			throw new Error("Cannot reply to this message");
		const recipients = await getReplyRecipients(context, source, input.replyAll as boolean);
		const subject = /^Re:/i.test(source.subject ?? "") ? source.subject! : `Re: ${source.subject ?? ""}`;
		return createDraft(context, { ...recipients, subject, body: input.body as string, source });
	}
	if (name === "edit_draft") return editAgentDraft(context, input as unknown as AgentDraftEditInput);
	if (name === "review_draft_send") {
		if (context.origin !== "chat") throw new Error("Open the draft in Kite to review delivery");
		const draft = await ownMessage(context, input.draftId as string);
		if (draft.status !== "draft") throw new Error("Draft not found in the selected mailbox");
		const result = await requestAgentSend(
			context.env,
			context.user,
			input.draftId as string,
			input.expectedRevision as number,
		);
		return {
			draftId: input.draftId,
			revision: input.expectedRevision,
			status: "pending_approval",
			scheduledAt: result.snapshot.scheduledAt,
			reviewUrl: result.reviewUrl,
		};
	}
	if (name === "discard_draft") {
		const row = await ownMessage(context, input.draftId as string);
		const [metadata] = await db
			.select()
			.from(agentDraftMetadata)
			.where(eq(agentDraftMetadata.draftId, row.id))
			.limit(1);
		if (row.status !== "draft" || !metadata || metadata.revision !== input.expectedRevision || metadata.humanEditedAt)
			throw new Error("Draft changed or cannot be discarded");
		if (context.origin === "chat")
			return {
				action: name,
				status: "pending_approval",
				draftId: row.id,
				expectedRevision: input.expectedRevision,
				emails: [publicMessage(row)],
			};
		await deleteMessageWithObjects(context.env, db, row.id, row.rawR2Key);
		return { draftId: row.id, status: "discarded" };
	}
	throw new Error("Unknown tool");
}
