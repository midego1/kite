"use client";

import { useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CardSuggestion } from "./suggestion-card-types";
import { runCardAction } from "./suggestion-card-actions";
import { phishingReasonTexts } from "./suggestion-card-utils";

/** The red phishing warning: its reasons in plain words and "Mark as spam". */
export function PhishingBlock({
	suggestion,
	menu,
	why,
	onChanged,
}: {
	suggestion: CardSuggestion;
	menu: ReactNode;
	why: ReactNode;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const reasons = phishingReasonTexts(suggestion);

	async function markSpam() {
		setBusy(true);
		const done = await runCardAction(suggestion, "mark_spam");
		setBusy(false);
		if (done) onChanged();
	}

	return (
		<div
			data-suggestion-block="phishing"
			data-suggestion-id={suggestion.id}
			role="alert"
			className="mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-900 first:mt-0"
		>
			<div className="flex items-start justify-between gap-2">
				<p className="flex items-center gap-2 font-medium">
					<ShieldAlert aria-hidden className="h-4 w-4 shrink-0 text-red-600" />
					{suggestion.title}
				</p>
				{menu}
			</div>
			{reasons.length > 0 && (
				<ul data-phishing-reasons className="mt-2 list-disc space-y-1 pl-6 text-sm text-red-800">
					{reasons.map((reason) => (
						<li key={reason}>{reason}</li>
					))}
				</ul>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				<Button size="sm" variant="destructive" disabled={busy} onClick={() => void markSpam()}>
					{busy ? "Moving…" : "Mark as spam"}
				</Button>
			</div>
			{why}
		</div>
	);
}
