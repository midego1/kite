"use client";

import { useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CardSuggestion } from "./suggestion-card-types";
import { announceSuggestionChange, runCardAction } from "./suggestion-card-actions";
import { runSingleMessageAction } from "@/components/message-actions/utils";
import { confirmReportPhishing } from "@/components/messages/phishing-report";
import toast from "react-hot-toast";
import { phishingReasonTexts } from "./suggestion-card-utils";

/** The red phishing warning: its reasons in plain words, "Mark as spam" and "Report phishing". */
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

	/** No Undo here: the report blocks the sender, which Contacts can lift. */
	async function reportPhishing() {
		if (!(await confirmReportPhishing(1))) return;
		setBusy(true);
		try {
			await runSingleMessageAction(suggestion.messageId, "phishing");
			announceSuggestionChange(suggestion);
			onChanged();
		} catch {
			toast.error("Kite could not report this message. Try again.");
		} finally {
			setBusy(false);
		}
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
				<Button
					size="sm"
					variant="outline"
					className="border-red-300 text-red-700 hover:bg-red-100"
					disabled={busy}
					onClick={() => void reportPhishing()}
				>
					Report phishing
				</Button>
			</div>
			{why}
		</div>
	);
}
