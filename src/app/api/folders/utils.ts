import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "@/db";
import { folders } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { selectRow, selectRows } from "@/lib/db/pending-columns";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

type Db = ReturnType<typeof getDb>;

export async function getMailboxFolderAccess(db: Db, user: SessionUser, mailboxId: string) {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return null;
	return { mailboxId: access.mailbox.id, mailboxUserId: access.mailbox.userId, canManage: access.canManage };
}

/** Whole rows through `selectRows`, so they still read before migration 0086 adds `color_is_custom`. */
export function listFoldersForMailbox(db: Db, mailboxId: string) {
	return selectRows(db, folders, eq(folders.mailboxId, mailboxId), undefined, asc(folders.name));
}

export async function getFolderForMailbox(db: Db, folderId: string, mailboxId: string) {
	return (await selectRow(db, folders, and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))) ?? null;
}
