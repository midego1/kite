import { and, eq, exists, gte, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import { viaSearchFilter } from "@/lib/external-accounts/via-utils";
import { buildFtsMatch, exactSenderMatch, parseSearchQuery } from "./query-utils";

/**
 * `via:`: messages whose connected account (`messages.external_account_id`) matches the value. The caller's mailbox
 * scope still applies, so it only narrows mail the user can already read.
 */
function viaCondition(value: string): SQL {
	const filter = viaSearchFilter(value);
	const matches = [
		sql`lower(${externalAccounts.address}) = ${filter.value}`,
		sql`lower(${externalAccounts.label}) = ${filter.value}`,
	];
	if (filter.presets.length)
		matches.push(
			sql`${externalAccounts.preset} IN (${sql.join(
				filter.presets.map((preset) => sql`${preset}`),
				sql`, `,
			)})`,
		);
	if (filter.domain) {
		// `LIKE … ESCAPE '\'`, so `_` and `%` in a domain are taken literally.
		const endsWith = `%@${filter.domain.replace(/[\\%_]/g, (char) => `\\${char}`)}`;
		matches.push(sql`lower(${externalAccounts.address}) LIKE ${endsWith} ESCAPE '\\'`);
	}
	return sql`${messages}.${sql.identifier("external_account_id")} IN (SELECT ${externalAccounts.id} FROM ${externalAccounts} WHERE ${sql.join(matches, sql` OR `)})`;
}

/**
 * Translate a search string into WHERE conditions on `messages`. Text goes to
 * the FTS5 index by rowid; everything else is a plain column predicate, so the
 * caller ANDs these with its own scope (mailbox access, folder, status).
 * `connectedAccounts: false` (before migration 0079, `viaSearchAvailable`) makes `via:` match nothing.
 */
export function buildSearchConditions(
	raw: string,
	timeZone = "UTC",
	options: { connectedAccounts?: boolean } = {},
): SQL[] {
	const parsed = parseSearchQuery(raw, timeZone);
	const conditions: SQL[] = [];

	const match = buildFtsMatch(parsed);
	if (match) {
		conditions.push(sql`${messages}.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match})`);
	}
	if (parsed.fromAddress) {
		const { equals, endsWith } = exactSenderMatch(parsed.fromAddress);
		conditions.push(
			sql`(lower(trim(${messages.fromAddr})) = ${equals} OR lower(trim(${messages.fromAddr})) LIKE ${endsWith} ESCAPE '\\')`,
		);
	}
	if (parsed.hasAttachment) {
		conditions.push(
			exists(
				sql`(SELECT 1 FROM ${messageAttachments} WHERE ${messageAttachments.messageId} = ${messages.id} AND ${messageAttachments.disposition} = 'attachment')`,
			),
		);
	}
	if (parsed.read === "read") conditions.push(eq(messages.read, true));
	if (parsed.read === "unread") conditions.push(eq(messages.read, false));
	if (parsed.starred) conditions.push(eq(messages.starred, true));
	if (parsed.after) conditions.push(gte(messages.createdAt, parsed.after));
	if (parsed.before) conditions.push(lt(messages.createdAt, parsed.before));
	if (parsed.via) conditions.push(options.connectedAccounts === false ? sql`0` : viaCondition(parsed.via));

	return conditions.length ? [and(...conditions)!] : [];
}
