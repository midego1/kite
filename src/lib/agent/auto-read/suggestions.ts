import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { newId } from "@/lib/ids";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import { moduleKindLabel, moduleKindPayloadSchema } from "./module-kinds";
import { storedSuggestionKinds } from "./module-steps-utils";
import type { PlannedSuggestion } from "./suggestion-types";
import { parseSuggestionPayload, suggestionExpiresAt, suggestionTitle } from "./suggestion-utils";

/** The kinds triage stores: reply suggestions are stored with their draft, every module kind as its step returned it. */
const STORED_KINDS: readonly string[] = storedSuggestionKinds(
	["summary", "phishing", "calendar_invite"],
	MODULE_CAPABILITIES,
);

type StoreInput = {
	env: CloudflareEnv;
	job: { id: string; mailboxId: string; reviewerUserId: string };
	source: { id: string; threadId: string | null };
	planned: PlannedSuggestion[];
	/** The triage model, or null when the suggestions came from facts alone. */
	model: string | null;
	now?: Date;
};

type StoredSuggestion = Pick<typeof agentSuggestions.$inferSelect, "id" | "status" | "draftId">;

/**
 * Upserts one suggestion for the message and kind. A suggestion the user already decided on keeps
 * its status and content; an open one is refreshed with the latest payload. Returns the stored row,
 * or null when the payload does not match its kind.
 */
export async function upsertSuggestion(
	input: Omit<StoreInput, "planned">,
	suggestion: PlannedSuggestion,
): Promise<StoredSuggestion | null> {
	const now = input.now ?? new Date();
	const db = getDb(input.env);
	const payload = parseSuggestionPayload(suggestion.kind, suggestion.payload, moduleKindPayloadSchema(suggestion.kind));
	if (!payload) return null;
	const values = {
		title: suggestionTitle(suggestion, moduleKindLabel(suggestion.kind)),
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
	const [row] = await db
		.select({ id: agentSuggestions.id, status: agentSuggestions.status, draftId: agentSuggestions.draftId })
		.from(agentSuggestions)
		.where(and(eq(agentSuggestions.messageId, input.source.id), eq(agentSuggestions.kind, suggestion.kind)))
		.limit(1);
	return row ?? null;
}

/** Stores the summary, phishing and module suggestions; the reply suggestion is stored with its draft. */
export async function storeTriageSuggestions(input: StoreInput): Promise<void> {
	for (const suggestion of input.planned)
		if (STORED_KINDS.includes(suggestion.kind)) await upsertSuggestion(input, suggestion);
}
