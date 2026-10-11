"use client";

import toast from "react-hot-toast";
import { showUndoToast } from "@/components/ui/undo-toast";
import type { InviteOption } from "@/lib/agent/auto-read/invite-actions-utils";
import { announceSuggestionChange, postSuggestion, undoAction } from "./suggestion-card-actions";
import type { CardSuggestion } from "./suggestion-card-types";

/** Answers with a decision on their way; a second click on the same suggestion does nothing. */
const inFlight = new Set<string>();

const DONE_TEXT: Partial<Record<InviteOption, string>> = {
	accept: "Accepted and added to your calendar",
	decline: "Declined the invitation",
	update: "Calendar event updated",
	remove: "Removed from your calendar",
	decline_instead: "Sent a decline instead",
	accept_instead: "Accepted instead",
};

const OFFERS_UNDO: readonly InviteOption[] = ["accept", "decline", "update", "remove"];

type InviteResponse = { actionId?: string; url?: string };

/**
 * Sends one answer to the calendar invitation and refreshes every surface. Accept, Decline, Update and
 * Remove offer Undo on the action the server recorded. Returns the draft URL for "Propose new time";
 * `done` is false when the same suggestion already had an answer in flight. Failures throw.
 */
export async function answerInvite(
	suggestion: Pick<CardSuggestion, "id" | "mailboxId">,
	option: InviteOption,
): Promise<{ done: boolean; url?: string }> {
	if (inFlight.has(suggestion.id)) return { done: false };
	inFlight.add(suggestion.id);
	try {
		const result = (await postSuggestion(suggestion.id, "accept", { option })) as InviteResponse;
		announceSuggestionChange(suggestion);
		const text = DONE_TEXT[option];
		const { actionId } = result;
		if (text && OFFERS_UNDO.includes(option) && actionId) {
			showUndoToast(text, async () => {
				await undoAction(actionId);
				announceSuggestionChange(suggestion);
			});
		} else if (text) toast.success(text);
		return { done: true, url: result.url };
	} finally {
		inFlight.delete(suggestion.id);
	}
}
