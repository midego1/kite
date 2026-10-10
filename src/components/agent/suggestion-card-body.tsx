"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, ShieldAlert, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { dispatchAgentSuggestionChanged } from "@/hooks/message-realtime-utils";
import { authFetch } from "@/lib/auth/client";
import { useAssistantOpen } from "./assistant-open-state";
import type { CardSuggestion, SuggestionCardBodyProps } from "./suggestion-card-types";
import { summaryText, whyDetails } from "./suggestion-card-utils";

async function postSuggestion(id: string, action: "accept" | "dismiss", body: object) {
	const response = await authFetch(`/api/agent/suggestions/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string; url?: string };
	if (!response.ok) throw new Error(data.error || "Kite could not do that. Try again.");
	return data;
}

function WhyDisclosure({ suggestion }: { suggestion: CardSuggestion }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const why = whyDetails(suggestion);
	return (
		<div className="mt-2">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(!open)}
				className="inline-flex items-center gap-1 rounded text-xs font-medium text-blue-700 hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
			>
				Why?
				<ChevronDown aria-hidden className={clsx("h-3 w-3 transition-transform", open && "rotate-180")} />
			</button>
			{open && (
				<div id={id} className="mt-1 space-y-0.5 text-xs text-neutral-600">
					<p>{why.reason}</p>
					<p>{why.model}</p>
				</div>
			)}
		</div>
	);
}

function ReplyBlock({ suggestion, onChanged }: { suggestion: CardSuggestion; onChanged: () => void }) {
	const router = useRouter();
	const [busy, setBusy] = useState<"review" | "discard" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run(kind: "review" | "discard") {
		setBusy(kind);
		setError(null);
		try {
			if (kind === "review") {
				const { url } = await postSuggestion(suggestion.id, "accept", { option: "review" });
				if (url) router.push(url);
				return;
			}
			await postSuggestion(suggestion.id, "dismiss", { discardDraft: true });
			dispatchAgentSuggestionChanged({ mailboxId: suggestion.mailboxId, suggestionId: suggestion.id });
			window.dispatchEvent(new Event("kite:messages-changed"));
			onChanged();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div data-suggestion-block="reply" data-suggestion-id={suggestion.id} className="mt-3 first:mt-0">
			<p className="font-medium text-neutral-900">{suggestion.title}</p>
			<p className="text-neutral-600">
				{suggestion.draftId ? "Kite drafted a reply. Review it before you send." : "The drafted reply is gone."}
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				{suggestion.draftId && (
					<Button size="sm" disabled={busy !== null} onClick={() => void run("review")}>
						{busy === "review" ? "Opening…" : "Review draft"}
					</Button>
				)}
				<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("discard")}>
					{busy === "discard" ? "Discarding…" : "Discard"}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-2 text-xs text-red-600">
					{error}
				</p>
			)}
			<WhyDisclosure suggestion={suggestion} />
		</div>
	);
}

function PhishingBlock({ suggestion }: { suggestion: CardSuggestion }) {
	return (
		<div
			data-suggestion-block="phishing"
			data-suggestion-id={suggestion.id}
			role="alert"
			className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 first:mt-0"
		>
			<p className="flex items-center gap-2 font-medium">
				<ShieldAlert aria-hidden className="h-4 w-4 text-red-600" />
				{suggestion.title}
			</p>
			<WhyDisclosure suggestion={suggestion} />
		</div>
	);
}

/** The reader card: the conversation summary, then one block per suggestion. */
export function SuggestionCardBody({ sections, onChanged }: SuggestionCardBodyProps) {
	const { visible: messageListVisible } = useMessageListVisibility();
	const assistantOpen = useAssistantOpen();
	const { summary, blocks } = sections;
	return (
		<div className={clsx(messageListVisible || assistantOpen ? "pl-10" : "pl-16", "pr-6 pb-4")}>
			<section
				aria-label="Kite suggestions"
				data-suggestion-card
				className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-sm"
			>
				<p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-blue-700">
					<Sparkles aria-hidden className="h-3.5 w-3.5" />
					Kite
				</p>
				{summary && (
					<div data-suggestion-summary className="mb-3 border-b border-blue-200 pb-3 last:mb-0 last:border-0 last:pb-0">
						<p className="text-neutral-800">{summaryText(summary)}</p>
						<WhyDisclosure suggestion={summary} />
					</div>
				)}
				{blocks.map((suggestion) =>
					suggestion.kind === "reply" ? (
						<ReplyBlock key={suggestion.id} suggestion={suggestion} onChanged={onChanged} />
					) : (
						<PhishingBlock key={suggestion.id} suggestion={suggestion} />
					),
				)}
			</section>
		</div>
	);
}
