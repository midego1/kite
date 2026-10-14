"use client";

import { useEffect, useState } from "react";
import { Link2, TriangleAlert, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { announceSuggestionChange, postSuggestion } from "@/components/agent/suggestion-card-actions";
import type { SuggestionBlockProps } from "@/components/agent/suggestion-card-types";
import { cancelLinkLine, documentLine, priceText } from "@/lib/finance/text-utils";
import type { SubscriptionPayload } from "@/lib/finance/types";
import { getUserTimeZone } from "@/lib/time/utils";

const BUTTONS: Record<SubscriptionPayload["event"], { option: string; label: string }> = {
	new: { option: "track", label: "Track" },
	trial: { option: "track", label: "Track" },
	renewal: { option: "track", label: "Update" },
	price_change: { option: "track", label: "Update" },
	payment_failed: { option: "mark_urgent", label: "Mark urgent" },
	refund: { option: "record", label: "Record it" },
};

function locale(): string {
	return typeof navigator === "undefined" ? "en" : navigator.language || "en";
}

type MessageDetail = { attachments?: { id: string; filename: string }[] };

/** The attachment's file name, read from the message the card belongs to. */
function useAttachmentName(messageId: string, attachmentId: string | null): string | null {
	const [name, setName] = useState<string | null>(null);
	useEffect(() => {
		if (!attachmentId) return;
		let live = true;
		fetch(`/api/messages/${encodeURIComponent(messageId)}`, { credentials: "same-origin" })
			.then((response) => (response.ok ? (response.json() as Promise<MessageDetail>) : null))
			.then((detail) => {
				const found = detail?.attachments?.find((item) => item.id === attachmentId);
				if (live && found) setName(found.filename);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [messageId, attachmentId]);
	return attachmentId ? name : null;
}

/** The open `subscription` card: what was found, what accepting records, the cancel link host and the answer. */
export function SubscriptionBlock({ suggestion, onChanged, menu, why }: SuggestionBlockProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const payload = suggestion.payload as unknown as SubscriptionPayload;
	const attachmentName = useAttachmentName(suggestion.messageId, payload?.document?.attachmentId ?? null);
	if (!payload || typeof payload.vendor !== "string") return null;
	const button = BUTTONS[payload.event] ?? BUTTONS.new;
	const price = priceText(payload, locale());
	const recorded = documentLine(payload, locale());

	async function answer() {
		setBusy(true);
		setError(null);
		try {
			await postSuggestion(suggestion.id, "accept", { option: button.option, deviceTimeZone: getUserTimeZone() });
			announceSuggestionChange(suggestion);
			onChanged();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div data-suggestion-block="subscription" data-suggestion-id={suggestion.id} className="mt-3 first:mt-0">
			<div className="flex items-start justify-between gap-2">
				<p className="flex items-center gap-2 font-medium text-neutral-900">
					<WalletCards aria-hidden className="h-4 w-4 shrink-0 text-blue-700" />
					{suggestion.title}
				</p>
				{menu}
			</div>
			{price && (
				<p data-subscription-price className="mt-1 text-neutral-800">
					{payload.vendor}
					{payload.plan && <span className="text-neutral-600"> · {payload.plan}</span>} · {price}
				</p>
			)}
			{recorded && (
				<p data-subscription-document className="text-xs text-neutral-600">
					{recorded}
					{attachmentName && <span data-subscription-attachment>. Attachment: {attachmentName}</span>}
				</p>
			)}
			<p data-subscription-cancel-link className="mt-1 flex items-center gap-1.5 text-xs text-neutral-600">
				<Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
				{cancelLinkLine(payload)}
			</p>
			{payload.unverified && (
				<p data-subscription-unverified className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
					<TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					Unverified sender: the message did not pass authentication checks
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				<Button size="sm" disabled={busy} onClick={() => void answer()}>
					{busy ? "Working…" : button.label}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-2 text-xs text-red-600">
					{error}
				</p>
			)}
			{why}
		</div>
	);
}
