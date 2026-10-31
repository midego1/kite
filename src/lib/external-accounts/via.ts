import { eq, inArray, isNotNull, and } from "drizzle-orm";
import { queryInChunks } from "@/db/chunk-utils";
import { getDb } from "@/db";
import { externalAccounts, messageExternalAccounts } from "@/db/schema/external-accounts";
import { externalAccountTablesReady } from "./errors";
import type { MessageVia } from "./via-utils";

/**
 * The connected account each of `rows` came in by (or went out through), for the "via" chip on list rows and in the
 * reader. Messages of a removed account have no account any more (`ON DELETE SET NULL`) and get no chip. Before
 * migration 0079 nothing has one, and nothing is read.
 */
export async function loadMessageVia(
	env: CloudflareEnv,
	rows: readonly { id: string }[],
): Promise<Map<string, MessageVia>> {
	const via = new Map<string, MessageVia>();
	if (!rows.length || !(await externalAccountTablesReady(env))) return via;
	const db = getDb(env);
	const found = await queryInChunks(
		rows.map((row) => row.id),
		(ids) =>
			db
				.select({
					messageId: messageExternalAccounts.id,
					accountId: externalAccounts.id,
					label: externalAccounts.label,
					address: externalAccounts.address,
					preset: externalAccounts.preset,
				})
				.from(messageExternalAccounts)
				.innerJoin(externalAccounts, eq(externalAccounts.id, messageExternalAccounts.externalAccountId))
				.where(and(inArray(messageExternalAccounts.id, ids), isNotNull(messageExternalAccounts.externalAccountId))),
	);
	for (const { messageId, ...account } of found) via.set(messageId, account);
	return via;
}

/**
 * Whether a search may use `via:` (it reads `messages.external_account_id` and `external_accounts`, migration 0079).
 * Only asked when the query names it, so other searches never wait on the check.
 */
export async function viaSearchAvailable(env: CloudflareEnv, query: string | null | undefined): Promise<boolean> {
	if (!query || !/(^|\s)via:/i.test(query)) return true;
	return externalAccountTablesReady(env);
}
