import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * The Kite folder an import files mail into by name: an existing one of the mailbox (names compared without case,
 * as the import page always did), else a new one owned by the mailbox's owner.
 */
export async function ensureImportFolder(
	env: CloudflareEnv,
	mailbox: { id: string; userId: string },
	name: string,
): Promise<string> {
	const db = getDb(env);
	const wanted = name.trim().slice(0, 80).trim() || "Imported";
	const find = async () => {
		const [row] = await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.mailboxId, mailbox.id), sql`lower(${folders.name}) = lower(${wanted})`))
			.limit(1);
		return row?.id ?? null;
	};
	const existing = await find();
	if (existing) return existing;
	// A concurrent run may create it first; the unique (mailbox, name) index keeps one.
	await db
		.insert(folders)
		.values({ id: newId("fld"), userId: mailbox.userId, mailboxId: mailbox.id, name: wanted })
		.onConflictDoNothing();
	const created = await find();
	if (!created) throw new Error(`Could not create the folder ${wanted}`);
	return created;
}

/**
 * A destination as stored on a job: `new:<name>` becomes `folder:<id>` (creating the folder); `folder:<id>` must be a
 * folder of the mailbox (null otherwise); `system:` and `gmail:labels` stay as they are.
 */
export async function resolveImportDestination(
	env: CloudflareEnv,
	mailbox: { id: string; userId: string },
	destination: string,
): Promise<string | null> {
	if (destination.startsWith("new:")) return `folder:${await ensureImportFolder(env, mailbox, destination.slice(4))}`;
	if (!destination.startsWith("folder:")) return destination;
	const [row] = await getDb(env)
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, destination.slice("folder:".length)), eq(folders.mailboxId, mailbox.id)))
		.limit(1);
	return row ? destination : null;
}
