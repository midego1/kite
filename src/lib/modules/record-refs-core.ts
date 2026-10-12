import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAccess, mailboxes, messages, users } from "@/db/schema";
import type { RecordKind } from "./module-types";
import type { RawRefResult, RefViewer } from "./record-ref-types";

type Db = ReturnType<typeof getDb>;

/** Stays under D1's bound-parameter limit together with the viewer id. */
const IDS_PER_QUERY = 50;

/** Folder pages that open a message by id; every other status opens in the inbox. */
const MESSAGE_FOLDERS: Record<string, string> = {
	sent: "sent",
	draft: "drafts",
	spam: "spam",
	trash: "trash",
	archived: "archived",
};

function chunks<T>(items: T[]): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += IDS_PER_QUERY) out.push(items.slice(start, start + IDS_PER_QUERY));
	return out;
}

const messageHref = (status: string, id: string) => `/${MESSAGE_FOLDERS[status] ?? "inbox"}/${encodeURIComponent(id)}`;

type MailAccessRow = { mailboxUserId: string; type: string; disabled: boolean; permission: string | null };

/** Owner of the mailbox, or a user a shared mailbox was shared with (any permission reads). */
function canReadMailbox(viewer: RefViewer, row: MailAccessRow): boolean {
	if (row.disabled) return false;
	if (row.mailboxUserId === viewer.userId) return true;
	return row.type === "shared" && row.permission !== null;
}

function messageRows(db: Db, viewer: RefViewer, where: ReturnType<typeof inArray>) {
	return db
		.select({
			id: messages.id,
			userId: messages.userId,
			status: messages.status,
			subject: messages.subject,
			threadId: messages.threadId,
			createdAt: messages.createdAt,
			mailboxUserId: mailboxes.userId,
			type: mailboxes.type,
			disabled: mailboxes.disabled,
			permission: mailboxAccess.permission,
		})
		.from(messages)
		.innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.leftJoin(mailboxAccess, and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, viewer.userId)))
		.where(where)
		.orderBy(desc(messages.createdAt));
}

/** Module-owned rows (templates) are not mail, and a draft is private to the user who wrote it. */
function readableMessage(viewer: RefViewer, row: MailAccessRow & { status: string; userId: string }): boolean {
	if (!canReadMailbox(viewer, row) || row.status === "template") return false;
	return row.status !== "draft" || row.userId === viewer.userId;
}

const subjectOf = (subject: string | null) => subject?.trim() || "(No subject)";

async function resolveMessages(db: Db, viewer: RefViewer, ids: string[]): Promise<RawRefResult[]> {
	const out: RawRefResult[] = [];
	for (const group of chunks(ids)) {
		const rows = await messageRows(db, viewer, inArray(messages.id, group));
		for (const row of rows)
			if (readableMessage(viewer, row))
				out.push({
					kind: "mail:message",
					id: row.id,
					href: messageHref(row.status, row.id),
					label: subjectOf(row.subject),
				});
	}
	return out;
}

/** The newest readable message stands for the thread. */
async function resolveThreads(db: Db, viewer: RefViewer, ids: string[]): Promise<RawRefResult[]> {
	const out: RawRefResult[] = [];
	for (const group of chunks(ids)) {
		const rows = await messageRows(db, viewer, inArray(messages.threadId, group));
		for (const threadId of group) {
			const newest = rows.find(
				(row) => row.threadId === threadId && row.status !== "draft" && readableMessage(viewer, row),
			);
			if (newest)
				out.push({
					kind: "mail:thread",
					id: threadId,
					href: messageHref(newest.status, newest.id),
					label: subjectOf(newest.subject),
				});
		}
	}
	return out;
}

async function resolveMailboxes(db: Db, viewer: RefViewer, ids: string[]): Promise<RawRefResult[]> {
	const out: RawRefResult[] = [];
	for (const group of chunks(ids)) {
		const rows = await db
			.select({
				id: mailboxes.id,
				localPart: mailboxes.localPart,
				hostname: domains.hostname,
				mailboxUserId: mailboxes.userId,
				type: mailboxes.type,
				disabled: mailboxes.disabled,
				permission: mailboxAccess.permission,
			})
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.leftJoin(mailboxAccess, and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, viewer.userId)))
			.where(inArray(mailboxes.id, group));
		for (const row of rows)
			if (canReadMailbox(viewer, row))
				out.push({ kind: "mail:mailbox", id: row.id, href: "/inbox", label: `${row.localPart}@${row.hostname}` });
	}
	return out;
}

/** Admins see every account and link to its page; anyone else sees only themselves, as text. */
async function resolveUsers(db: Db, viewer: RefViewer, ids: string[]): Promise<RawRefResult[]> {
	const isAdmin = viewer.role === "admin";
	const allowed = ids.filter((id) => isAdmin || id === viewer.userId);
	const out: RawRefResult[] = [];
	for (const group of chunks(allowed)) {
		const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, group));
		for (const row of rows)
			out.push({
				kind: "user:user",
				id: row.id,
				href: isAdmin ? `/accounts/${encodeURIComponent(row.id)}` : null,
				label: row.name,
			});
	}
	return out;
}

/** Resolves refs of one core kind for a viewer; records the viewer cannot read are simply absent. */
export async function resolveCoreRefs(
	env: Pick<CloudflareEnv, "DB">,
	viewer: RefViewer,
	kind: RecordKind,
	ids: string[],
): Promise<RawRefResult[]> {
	const db = getDb(env);
	if (kind === "mail:message") return resolveMessages(db, viewer, ids);
	if (kind === "mail:thread") return resolveThreads(db, viewer, ids);
	if (kind === "mail:mailbox") return resolveMailboxes(db, viewer, ids);
	if (kind === "user:user") return resolveUsers(db, viewer, ids);
	return [];
}
