import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { externalIdentities } from "@/db/schema/external-accounts";

type StoreEnv = Pick<CloudflareEnv, "DB">;

export type ExternalIdentityRow = typeof externalIdentities.$inferSelect;

/** Migrations only add tables, so once it exists the check is skipped for the rest of the isolate's life. */
const readyDatabases = new WeakSet<object>();

/**
 * Whether migration 0089 has been applied. Reads only `sqlite_master`, so it never names a table that may be missing;
 * before it, no address has a code, every send-as check answers as it did without codes, and writes are refused.
 */
export async function externalIdentitiesReady(env: StoreEnv): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare("SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind("external_identities")
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === 1;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}

/** The addresses of each account, by account id; empty before migration 0089. */
export async function readIdentities(
	env: StoreEnv,
	accountIds: readonly string[],
): Promise<Map<string, ExternalIdentityRow[]>> {
	const byAccount = new Map<string, ExternalIdentityRow[]>();
	if (!accountIds.length || !(await externalIdentitiesReady(env))) return byAccount;
	const rows = await getDb(env)
		.select()
		.from(externalIdentities)
		.where(inJsonArray(externalIdentities.accountId, accountIds))
		.orderBy(externalIdentities.createdAt);
	for (const row of rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
	return byAccount;
}

/** The addresses among `rows` whose code was entered, lower-case. */
export function verifiedAddresses(rows: readonly ExternalIdentityRow[] | undefined): Set<string> {
	return new Set((rows ?? []).filter((row) => row.verifiedAt).map((row) => row.address));
}
