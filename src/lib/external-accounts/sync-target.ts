import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { connectRefusal } from "./access";
import type { ConnectRefusal } from "./types";

/** Why a connected account may not bring in mail right now. */
export type SyncRefusal = ConnectRefusal | "owner_disabled" | "mailbox_access";

/**
 * Whether an account may bring in mail now (spec §6.4, §9.3): connected accounts are on for the install and allowed
 * for the owner, the owner's Kite account is not disabled, and the owner still has full access to the mailbox the
 * account delivers into. Checked by every sync run before it connects and again when a synced message is delivered.
 */
export async function externalSyncRefusal(
	env: CloudflareEnv,
	account: { userId: string; mailboxId: string },
): Promise<SyncRefusal | null> {
	const refusal = await connectRefusal(env, account.userId);
	if (refusal) return refusal;
	const db = getDb(env);
	const [owner] = await db
		.select({ id: users.id, role: users.role, disabled: users.disabled })
		.from(users)
		.where(eq(users.id, account.userId))
		.limit(1);
	if (!owner || owner.disabled) return "owner_disabled";
	const access = await getMailboxAccessLevel(db, owner, account.mailboxId);
	return access?.canManage ? null : "mailbox_access";
}
