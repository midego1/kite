import { and, eq, inArray, notLike } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, agentSuggestions } from "@/db/schema/agent-auto-read";
import { UNDO_VARIANT_PREFIX } from "./actions-utils";
import { notifySuggestionsQuietly } from "./suggestion-events";

/**
 * After an undo, an accepted suggestion with no live action of the given types left is open again;
 * otherwise it stays decided. Inverse rows (`undo:<id>`) never count as live answers.
 */
export async function reopenSuggestionIfIdle(
	env: CloudflareEnv,
	suggestionId: string | null,
	actionTypes: readonly string[],
): Promise<boolean> {
	if (!suggestionId) return false;
	const db = getDb(env);
	const [live] =
		actionTypes.length > 0
			? await db
					.select({ id: agentActions.id })
					.from(agentActions)
					.where(
						and(
							eq(agentActions.suggestionId, suggestionId),
							inArray(agentActions.action, [...actionTypes]),
							inArray(agentActions.status, ["pending", "applied"]),
							notLike(agentActions.variant, `${UNDO_VARIANT_PREFIX}%`),
						),
					)
					.limit(1)
			: [];
	if (live) return false;
	const reopened = await db
		.update(agentSuggestions)
		.set({ status: "open", decidedAt: null, decidedByUserId: null })
		.where(and(eq(agentSuggestions.id, suggestionId), eq(agentSuggestions.status, "accepted")))
		.returning({ id: agentSuggestions.id });
	await notifySuggestionsQuietly(env, [suggestionId]);
	return reopened.length > 0;
}
