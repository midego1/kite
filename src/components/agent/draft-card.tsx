"use client";

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { fetchDraft } from "@/components/compose/utils";
import type { ComposeDraft } from "@/components/compose/types";
import type { AgentDraftAction, AgentTurnProps } from "./types";

export function AgentDraftActions({
	action,
	onOpenDraft,
	onApproveDraft,
	approvingId,
}: { action: AgentDraftAction } & Pick<AgentTurnProps, "onOpenDraft" | "onApproveDraft" | "approvingId">) {
	const [draft, setDraft] = useState<ComposeDraft | null>(null);
	const [error, setError] = useState(false);
	useEffect(() => {
		let active = true;
		fetchDraft(action.draftId)
			.then((value) => {
				if (active) setDraft(value);
			})
			.catch(() => {
				if (active) setError(true);
			});
		return () => {
			active = false;
		};
	}, [action.draftId, action.revision]);
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
					: error
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
