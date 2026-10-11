"use client";

import toast from "react-hot-toast";
import { showUndoToast } from "@/components/ui/undo-toast";
import { dispatchAgentSuggestionChanged } from "@/hooks/message-realtime-utils";
import { authFetch } from "@/lib/auth/client";
import { dispatchAgentSettingsChanged, loadAutoReadSettings } from "./auto-read-settings-utils";
import type { CardSuggestion } from "./suggestion-card-types";
import { pauseEnd, pauseUndoValue } from "./suggestion-card-utils";

type DecisionResponse = { error?: string; url?: string; actionId?: string; mutedSender?: string | null };

/** Suggestions with a decision on its way; a second click while one is in flight does nothing. */
const inFlight = new Set<string>();

async function readJson<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as T;
	if (!response.ok) throw new Error(data.error || fallback);
	return data;
}

export async function postSuggestion(id: string, action: "accept" | "dismiss", body: object) {
	const response = await authFetch(`/api/agent/suggestions/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return readJson<DecisionResponse>(response, "Kite could not do that. Try again.");
}

/** Tells the badge, For you, Activity and the mail lists that a suggestion or message changed. */
export function announceSuggestionChange(suggestion: Pick<CardSuggestion, "id" | "mailboxId">) {
	dispatchAgentSuggestionChanged({ mailboxId: suggestion.mailboxId, suggestionId: suggestion.id });
	window.dispatchEvent(new Event("kite:messages-changed"));
}

/** The same request as Undo in Activity, so both record the undo on the action row. */
async function undoAction(actionId: string) {
	const response = await authFetch(`/api/agent/actions/${encodeURIComponent(actionId)}/undo`, { method: "POST" });
	await readJson<{ error?: string }>(response, "The action could not be undone.");
}

async function savePause(mailboxId: string, pausedUntil: string | null) {
	const response = await authFetch("/api/agent/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, pausedUntil }),
	});
	await readJson<{ error?: string }>(response, "Could not change the pause for this mailbox.");
	dispatchAgentSettingsChanged(mailboxId);
}

/** Pauses for a day; Undo goes back to the pause the mailbox already had, if it had one. */
async function pauseMailbox(mailboxId: string): Promise<() => Promise<void>> {
	const { settings } = await loadAutoReadSettings(mailboxId);
	const previous = pauseUndoValue(settings.pausedUntil, new Date());
	await savePause(mailboxId, pauseEnd(new Date()));
	return () => savePause(mailboxId, pauseUndoValue(previous, new Date()));
}

export type CardAction = "dismiss" | "mute" | "pause" | "mark_spam";

const TOAST_TEXT: Record<CardAction, string> = {
	dismiss: "Suggestion dismissed",
	mute: "Kite will only warn about phishing from this sender",
	pause: "Kite is paused for this mailbox for 24 hours",
	mark_spam: "Moved to Spam",
};

async function apply(suggestion: CardSuggestion, action: CardAction): Promise<() => Promise<void>> {
	if (action === "pause") return pauseMailbox(suggestion.mailboxId);
	const { actionId } =
		action === "mark_spam"
			? await postSuggestion(suggestion.id, "accept", { option: "mark_spam" })
			: await postSuggestion(suggestion.id, "dismiss", action === "mute" ? { muteSender: true } : {});
	return async () => {
		if (actionId) await undoAction(actionId);
	};
}

/**
 * Runs a card action once, refreshes every surface, and offers Undo in a toast. Returns false when
 * the same suggestion already has an action in flight, so a double click applies once.
 */
export async function runCardAction(suggestion: CardSuggestion, action: CardAction): Promise<boolean> {
	if (inFlight.has(suggestion.id)) return false;
	inFlight.add(suggestion.id);
	try {
		const undo = await apply(suggestion, action);
		announceSuggestionChange(suggestion);
		showUndoToast(TOAST_TEXT[action], async () => {
			await undo();
			announceSuggestionChange(suggestion);
		});
		return true;
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Kite could not do that. Try again.");
		return false;
	} finally {
		inFlight.delete(suggestion.id);
	}
}
