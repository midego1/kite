import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountFolders, type externalAccounts } from "@/db/schema/external-accounts";
import type { ExternalAccountView } from "./types";

/** The switches of an edit that need no sign-in: send-as (spec §7.4, §16.3) and syncing the Spam folder (§6.3). */
const SWITCHES: readonly string[] = [
	"sendEnabled",
	"appendSent",
	"syncJunk",
] satisfies (keyof typeof externalAccounts.$inferInsert)[];

/** Whether an edit changes only switches, so nothing about the sign-in or the servers is read or checked again. */
export function isSwitchesOnly(keys: readonly string[]): boolean {
	return keys.length > 0 && keys.every((key) => SWITCHES.includes(key));
}

/** The switches an edit sets, as columns; anything but a boolean is ignored. */
export function accountSwitches(body: Record<string, unknown>): Partial<typeof externalAccounts.$inferInsert> {
	return Object.fromEntries(SWITCHES.filter((key) => typeof body[key] === "boolean").map((key) => [key, body[key]]));
}

/**
 * Turning "Also sync the Spam folder" on starts its cursor again: the Spam folder is checked from that moment, never
 * for what collected there while it was off.
 */
export async function restartJunkCursor(
	env: CloudflareEnv,
	id: string,
	current: Pick<ExternalAccountView, "sync">,
	body: Record<string, unknown>,
): Promise<void> {
	if (body.syncJunk !== true || current.sync.junk) return;
	await getDb(env)
		.delete(externalAccountFolders)
		.where(and(eq(externalAccountFolders.accountId, id), eq(externalAccountFolders.role, "junk")));
}
