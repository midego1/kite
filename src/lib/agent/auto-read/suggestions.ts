import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { newId } from "@/lib/ids";
import type { PlannedSuggestion, SuggestionKind } from "./suggestion-types";
import { parseSuggestionPayload, suggestionExpiresAt, suggestionTitle } from "./suggestion-utils";

/** The kinds triage stores so far; reply drafts and invites are created by their own steps. */
const STORED_KINDS: readonly SuggestionKind[] = ["summary", "phishing"];

type StoreInput = {
	env: CloudflareEnv;
	job: { id: string; mailboxId: string; reviewerUserId: string };
	source: { id: string; threadId: string | null };
	planned: PlannedSuggestion[];
	/** The triage model, or null when the suggestions came from facts alone. */
	model: string | null;
	now?: Date;
};

/**
 * Upserts one suggestion per message and kind. A suggestion the user already decided on keeps its
 * status and content; an open one is refreshed with the latest payload.
 */
export async function storeTriageSuggestions(input: StoreInput): Promise<void> {
	const now = input.now ?? new Date();
	const db = getDb(input.env);
	for (const suggestion of input.planned) {
		if (!STORED_KINDS.includes(suggestion.kind)) continue;
		const payload = parseSuggestionPayload(suggestion.kind, suggestion.payload);
		if (!payload) continue;
		const values = {
			title: suggestionTitle(suggestion),
			payload: JSON.stringify({ ...payload, reason: suggestion.reason }),
			model: input.model,
			jobId: input.job.id,
		};
		await db
			.insert(agentSuggestions)
			.values({
				id: newId("asug"),
				mailboxId: input.job.mailboxId,
				messageId: input.source.id,
				threadId: input.source.threadId,
				reviewerUserId: input.job.reviewerUserId,
				kind: suggestion.kind,
				createdAt: now,
				expiresAt: suggestionExpiresAt(now),
				...values,
			})
			.onConflictDoUpdate({
				target: [agentSuggestions.messageId, agentSuggestions.kind],
				set: values,
				setWhere: eq(agentSuggestions.status, "open"),
			});
	}
}
