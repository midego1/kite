import { and, desc, eq, inArray, notLike } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema/agent-auto-read";
import { UNDO_VARIANT_PREFIX } from "./actions-utils";
import type { Partstat, RsvpState } from "./invite-actions-utils";
import { reopenSuggestionIfIdle } from "./suggestion-reopen";

const CALENDAR_ACTIONS = ["create_event", "delete_event", "send_rsvp"] as const;
const NOT_UNDO_ROW = notLike(agentActions.variant, `${UNDO_VARIANT_PREFIX}%`);

/** The reply standing for the invitation: the newest pending or applied `send_rsvp` row. */
export async function rsvpState(env: CloudflareEnv, suggestionId: string): Promise<RsvpState> {
	const [row] = await getDb(env)
		.select({ variant: agentActions.variant })
		.from(agentActions)
		.where(
			and(
				eq(agentActions.suggestionId, suggestionId),
				eq(agentActions.action, "send_rsvp"),
				inArray(agentActions.variant, ["accepted", "declined"]),
				inArray(agentActions.status, ["pending", "applied"]),
			),
		)
		.orderBy(desc(agentActions.createdAt))
		.limit(1);
	return (row?.variant as Partstat | undefined) ?? null;
}

type RetireInput = {
	suggestionId: string;
	rows: { action: (typeof CALENDAR_ACTIONS)[number]; variant?: string }[];
	userId: string;
	now?: Date;
};

/**
 * Marks earlier applied rows undone when a later step supersedes them, so one live row exists per
 * outcome and a repeated outcome (accept again after declining) is not blocked by the live-row index.
 */
export async function retireLiveRows(env: CloudflareEnv, input: RetireInput): Promise<void> {
	const db = getDb(env);
	const now = input.now ?? new Date();
	for (const { action, variant } of input.rows)
		await db
			.update(agentActions)
			.set({ status: "undone", undoneAt: now, undoneByUserId: input.userId, updatedAt: now })
			.where(
				and(
					eq(agentActions.suggestionId, input.suggestionId),
					eq(agentActions.action, action),
					eq(agentActions.status, "applied"),
					variant === undefined ? NOT_UNDO_ROW : eq(agentActions.variant, variant),
				),
			);
}

/** After an undo, a suggestion whose calendar actions are all gone is open again; otherwise it stays decided. */
export async function reopenIfIdle(env: CloudflareEnv, suggestionId: string | null): Promise<void> {
	await reopenSuggestionIfIdle(env, suggestionId, CALENDAR_ACTIONS);
}
