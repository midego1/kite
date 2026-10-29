import { sql, type SQL } from "drizzle-orm";
import { externalAccounts } from "@/db/schema/external-accounts";

/** How many problems an account keeps (`recent_errors`). */
const KEPT = 20;

/**
 * The new value of `recent_errors` with `messages` appended at `at`, as one SQL expression over the stored value, so
 * writers that race (a sync run, a delivery, a connection test) never lose each other's entries the way reading the
 * list, appending and writing it back would. A damaged stored value counts as empty and entries that are not objects are dropped; only the last 20 stay.
 */
export function appendRecentErrors(messages: readonly string[], at: Date): SQL {
	const column = sql`${externalAccounts.recentErrors}`;
	const added = JSON.stringify(messages.map((message) => ({ at: at.toISOString(), message })));
	return sql`(SELECT coalesce(json_group_array(json(value)), '[]') FROM (
		SELECT value FROM (
			SELECT value, part, position, row_number() OVER (ORDER BY part DESC, position DESC) AS newest FROM (
				SELECT value, 0 AS part, key AS position FROM json_each(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END) WHERE type = 'object'
				UNION ALL SELECT value, 1 AS part, key AS position FROM json_each(${added})
			)
		) WHERE newest <= ${KEPT} ORDER BY part, position
	))`;
}
