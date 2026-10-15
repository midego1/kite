import { and, eq, notInArray, or, type SQL } from "drizzle-orm";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import type { SessionUser } from "@/lib/auth/types";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { listEnabledModules } from "@/lib/modules/state";
import { hiddenSuggestionKinds, reviewerOnlySuggestionKinds } from "./module-steps-utils";
import type { SuggestionKind } from "./suggestion-types";

const REVIEWER_ONLY_KINDS = reviewerOnlySuggestionKinds(MODULE_CAPABILITIES);

export type SuggestionVisibility = {
	userId: string;
	/** Kinds owned by a module that is off for the user. */
	hidden: readonly SuggestionKind[];
	/** Kinds only the suggestion's reviewer sees. */
	reviewerOnly: readonly string[];
};

/**
 * What lists, counts, badges and cards must leave out for this user: kinds whose module is off (the rows
 * stay stored, so turning the module back on shows them unchanged) and reviewer-only kinds of
 * suggestions someone else reviews.
 */
export async function suggestionVisibilityFor(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin">,
): Promise<SuggestionVisibility> {
	const enabled = await listEnabledModules(env, {
		userId: user.id,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin,
	});
	return {
		userId: user.id,
		hidden: hiddenSuggestionKinds(MODULE_CAPABILITIES, enabled) as SuggestionKind[],
		reviewerOnly: REVIEWER_ONLY_KINDS,
	};
}

/** The `agent_suggestions` condition for a visibility, or undefined when nothing is left out. */
export function visibleSuggestionsWhere(visibility: SuggestionVisibility | null): SQL | undefined {
	if (!visibility) return undefined;
	const hidden = visibility.hidden.length > 0 ? notInArray(agentSuggestions.kind, [...visibility.hidden]) : undefined;
	const reviewer =
		visibility.reviewerOnly.length > 0
			? or(
					notInArray(agentSuggestions.kind, [...visibility.reviewerOnly]),
					eq(agentSuggestions.reviewerUserId, visibility.userId),
				)
			: undefined;
	return hidden && reviewer ? and(hidden, reviewer) : (hidden ?? reviewer);
}
