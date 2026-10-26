"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Mail } from "lucide-react";
import { fetchDraft } from "@/components/compose/utils";
import type { ComposeDraft } from "@/components/compose/types";
import { formatUserDate } from "@/lib/time/utils";
import { fetchAgentDraftState } from "./client-actions";
import {
	DRAFT_UNAVAILABLE_TEXT,
	draftStateHeading,
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

/** The draft while it is one; otherwise what became of it, so a sent or removed draft never offers to be approved. */
async function loadDraftCard(draftId: string): Promise<DraftCardState> {
	try {
		return { kind: "draft", draft: await fetchDraft(draftId) };
	} catch {
		try {
			const state = await fetchAgentDraftState(draftId);
			if (isFinishedDraftState(state)) return { kind: "finished", state };
			return state.state === "unavailable" ? { kind: "unavailable" } : { kind: "error" };
		} catch {
			return { kind: "error" };
		}
	}
}

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
		const load = () => {
			const request = ++latest;
			void loadDraftCard(action.draftId).then((value) => {
				if (active && request === latest) setCard(value);
			});
		};
		load();
		// Approving the draft elsewhere in the panel announces the change, which turns this card into "Sent".
		window.addEventListener("kite:messages-changed", load);
		return () => {
			active = false;
			window.removeEventListener("kite:messages-changed", load);
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
	const failed = state.state === "failed";
	return (
		<section
			aria-label="Reply draft"
			className="overflow-hidden rounded-xl border border-blue-100 bg-white p-3 text-xs shadow-sm"
		>
			<div className="flex items-start gap-2">
				<CheckCircle2
					size={16}
					className={`mt-0.5 shrink-0 ${failed ? "text-red-600" : "text-green-700"}`}
					aria-hidden="true"
				/>
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
