"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Clock, Mail } from "lucide-react";
import { fetchDraft } from "@/components/compose/utils";
import type { ComposeDraft } from "@/components/compose/types";
import { formatUserDate } from "@/lib/time/utils";
import { fetchAgentDraftState } from "./client-actions";
import {
	DRAFT_UNAVAILABLE_TEXT,
	SENDING_POLL_DELAYS_MS,
	draftRefreshDelay,
	draftStateHeading,
	isBackoffState,
	isFinalDraftState,
	isFinishedDraftState,
	type FinishedDraftState,
} from "./draft-card-utils";
import type { AgentDraftAction, AgentTurnProps } from "./types";

type DraftCardState =
	| { kind: "loading" }
	| { kind: "draft"; draft: ComposeDraft }
	| { kind: "finished"; state: FinishedDraftState }
	| { kind: "unavailable" }
	| { kind: "error" };

/**
 * The draft while it is one; otherwise what became of it, so a sent or removed draft never offers to be approved.
 * A card that already knows the draft is gone asks for its state directly instead of probing the draft first.
 */
async function loadDraftCard(draftId: string, knownNonDraft: boolean): Promise<DraftCardState> {
	if (!knownNonDraft) {
		try {
			return { kind: "draft", draft: await fetchDraft(draftId) };
		} catch {
			/* Not a draft any more, or unreachable: the state tells which. */
		}
	}
	try {
		const state = await fetchAgentDraftState(draftId);
		if (isFinishedDraftState(state)) return { kind: "finished", state };
		return state.state === "unavailable" ? { kind: "unavailable" } : { kind: "error" };
	} catch {
		return { kind: "error" };
	}
}

const EVENT_DEBOUNCE_MS = 150;

export function AgentDraftActions({
	action,
	onOpenDraft,
	onApproveDraft,
	approvingId,
}: { action: AgentDraftAction } & Pick<AgentTurnProps, "onOpenDraft" | "onApproveDraft" | "approvingId">) {
	const [card, setCard] = useState<DraftCardState>({ kind: "loading" });
	useEffect(() => {
		let active = true;
		// Only the newest request may update the card, or a read that began before the send could bring the buttons back.
		let latest = 0;
		let knownNonDraft = false;
		let polls = 0;
		let eventTimer: number | null = null;
		let pollTimer: number | null = null;
		const clearTimers = () => {
			if (eventTimer) window.clearTimeout(eventTimer);
			if (pollTimer) window.clearTimeout(pollTimer);
			eventTimer = pollTimer = null;
		};
		// Approving the draft elsewhere in the panel announces the change, which turns this card into "Sent".
		const onMessagesChanged = () => {
			if (document.visibilityState !== "visible") return;
			if (eventTimer) window.clearTimeout(eventTimer);
			eventTimer = window.setTimeout(load, EVENT_DEBOUNCE_MS);
		};
		const stop = () => {
			clearTimers();
			window.removeEventListener("kite:messages-changed", onMessagesChanged);
		};
		function apply(value: DraftCardState) {
			if (value.kind === "error" && knownNonDraft) {
				// A failed look at a draft that is already sent or scheduled keeps what the card showed (never the draft
				// buttons) and tries again with growing waits.
				const retry = SENDING_POLL_DELAYS_MS[polls++];
				if (retry !== undefined) pollTimer = window.setTimeout(load, retry);
				return;
			}
			setCard(value);
			knownNonDraft = value.kind === "finished" || value.kind === "unavailable";
			if (value.kind === "unavailable" || (value.kind === "finished" && isFinalDraftState(value.state))) return stop();
			if (value.kind !== "finished") return;
			// A scheduled or in-flight send changes without any mail event, so look at it again on a timer.
			const now = Date.now();
			const delay = draftRefreshDelay(value.state, polls, now);
			// Repeated "scheduled" answers past the send time (a fast client clock) back off like "sending".
			polls = isBackoffState(value.state, now) ? polls + 1 : 0;
			if (delay !== null) pollTimer = window.setTimeout(load, delay);
		}
		function load() {
			clearTimers();
			const request = ++latest;
			void loadDraftCard(action.draftId, knownNonDraft).then((value) => {
				if (active && request === latest) apply(value);
			});
		}
		load();
		window.addEventListener("kite:messages-changed", onMessagesChanged);
		return () => {
			active = false;
			stop();
		};
	}, [action.draftId, action.revision]);
	if (card.kind === "finished") return <FinishedDraftCard state={card.state} />;
	if (card.kind === "unavailable")
		return (
			<section
				aria-label="Reply draft"
				className="overflow-hidden rounded-xl border border-neutral-200 bg-white p-3 text-xs text-neutral-500 shadow-sm"
			>
				<div className="flex items-center gap-2">
					<Mail size={16} className="shrink-0" aria-hidden="true" />
					<p>{DRAFT_UNAVAILABLE_TEXT}</p>
				</div>
			</section>
		);
	const draft = card.kind === "draft" ? card.draft : null;
	return (
		<section
			aria-label="Reply draft"
			className="overflow-hidden rounded-xl border border-blue-100 bg-white p-3 text-xs shadow-sm"
		>
			<div className="flex items-start gap-2 border-b border-neutral-100 pb-2">
				<Mail size={16} className="mt-0.5 shrink-0 text-blue-800" aria-hidden="true" />
				<div className="min-w-0">
					<p className="font-semibold text-neutral-900">{draft?.subject || "Reply draft"}</p>
					{draft && <p className="mt-0.5 break-words text-neutral-500">To {draft.toAddr}</p>}
				</div>
			</div>
			<div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words py-3 leading-relaxed text-neutral-700">
				{draft
					? draft.textBody || "Open the draft to review its content."
					: card.kind === "error"
						? "Preview unavailable. Open the draft to review it."
						: "Loading draft…"}
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-2">
				<button
					type="button"
					onClick={() => onOpenDraft(action.draftId)}
					className="rounded-lg bg-blue-900 px-3 py-2 font-medium text-blue-50 hover:bg-blue-800"
				>
					Edit draft
				</button>
				<button
					type="button"
					className="rounded-lg border border-blue-200 px-3 py-2 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
					disabled={approvingId === action.draftId}
					onClick={() => onApproveDraft(action.draftId, action.revision)}
				>
					{action.scheduledAt ? "Schedule" : "Approve to send"}
				</button>
			</div>
		</section>
	);
}

function FinishedDraftCard({ state }: { state: FinishedDraftState }) {
	return (
		<section
			aria-label="Reply draft"
			className="overflow-hidden rounded-xl border border-blue-100 bg-white p-3 text-xs shadow-sm"
		>
			<div className="flex items-start gap-2">
				<FinishedDraftIcon state={state} />
				<div className="min-w-0">
					<p className="font-semibold text-neutral-900">
						{draftStateHeading(state, (iso) => formatUserDate(iso, { dateStyle: "medium", timeStyle: "short" }))}
					</p>
					{state.subject && <p className="mt-0.5 break-words text-neutral-700">{state.subject}</p>}
					{state.to && <p className="mt-0.5 break-words text-neutral-500">To {state.to}</p>}
					{state.state === "sent" && state.messageId && (
						<Link
							href={`/sent/${encodeURIComponent(state.messageId)}`}
							className="mt-2 inline-block font-medium text-blue-700 underline"
						>
							View message
						</Link>
					)}
				</div>
			</div>
		</section>
	);
}

function FinishedDraftIcon({ state }: { state: FinishedDraftState }) {
	const className = "mt-0.5 shrink-0";
	if (state.state === "failed")
		return <AlertCircle size={16} className={`${className} text-red-600`} aria-hidden="true" />;
	if (state.state === "scheduled" || state.state === "sending")
		return <Clock size={16} className={`${className} text-blue-700`} aria-hidden="true" />;
	return <CheckCircle2 size={16} className={`${className} text-green-700`} aria-hidden="true" />;
}
