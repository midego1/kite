import { and, isNull, ne, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";

/** Starts the 30-day erase clock of every matching account that still holds a password and is not already counting. */
export async function suspendAccounts(env: Pick<CloudflareEnv, "DB">, where: SQL | undefined, now: Date) {
	await getDb(env)
		.update(externalAccounts)
		.set({ suspendedAt: now })
		.where(and(where, ne(externalAccounts.secret, ""), isNull(externalAccounts.suspendedAt)));
}
