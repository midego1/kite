"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadModuleClient, suggestionKindModule } from "@/components/modules/client-registry";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { useAssistantOpen } from "./assistant-open-state";
import { announceSuggestionChange, postSuggestion } from "./suggestion-card-actions";
import { SuggestionCardMenu } from "./suggestion-card-menu";
import type { CardSuggestion, ModuleSuggestionCard, SuggestionCardBodyProps } from "./suggestion-card-types";
import { replyStatusText, summaryText, whyDetails } from "./suggestion-card-utils";
import { PhishingBlock } from "./suggestion-phishing-block";

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
			announceSuggestionChange(suggestion);
			onChanged();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div data-suggestion-block="reply" data-suggestion-id={suggestion.id} className="mt-3 first:mt-0">
			<div className="flex items-start justify-between gap-2">
				<p className="font-medium text-neutral-900">{suggestion.title}</p>
				<SuggestionCardMenu suggestion={suggestion} onChanged={onChanged} />
			</div>
			<p className="text-neutral-600">{replyStatusText(suggestion)}</p>
			<div className="mt-2 flex flex-wrap gap-2">
				{suggestion.draftId && suggestion.canReviewDraft && (
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

/** The card a module draws for a kind, loaded with the module's client chunk; null while it loads. */
function useModuleCard(kind: string): ModuleSuggestionCard | null {
	const [card, setCard] = useState<ModuleSuggestionCard | null>(null);
	useEffect(() => {
		const moduleId = suggestionKindModule(kind);
		const client = moduleId ? loadModuleClient(moduleId) : null;
		if (!client) return;
		let live = true;
		void client.then((loaded) => {
			if (live) setCard(loaded.suggestionCards?.[kind] ?? null);
		});
		return () => {
			live = false;
		};
	}, [kind]);
	return card;
}

function ModuleBlock({
	suggestion,
	onChanged,
	answered = false,
}: {
	suggestion: CardSuggestion;
	onChanged: () => void;
	answered?: boolean;
}): ReactNode {
	const card = useModuleCard(suggestion.kind);
	if (!card) return null;
	if (answered) return card.Answered ? <card.Answered suggestion={suggestion} onChanged={onChanged} /> : null;
	return (
		<card.Block
			suggestion={suggestion}
			onChanged={onChanged}
			menu={<SuggestionCardMenu suggestion={suggestion} onChanged={onChanged} />}
			why={<WhyDisclosure suggestion={suggestion} />}
		/>
	);
}

/** The reader card: the conversation summary, then one block per suggestion. */
export function SuggestionCardBody({ sections, onChanged }: SuggestionCardBodyProps) {
	const { visible: messageListVisible } = useMessageListVisibility();
	const assistantOpen = useAssistantOpen();
	const { summary, blocks, answered } = sections;
	return (
		<div className="px-4 pb-5 sm:px-7">
			<section
				aria-label="Kite suggestions"
				data-suggestion-card
				// Zero's "AI Summary" box: an indigo outline on the panel, the summary first.
				className="rounded-xl border border-indigo-400/60 bg-indigo-500/[0.04] p-4 text-sm"
			>
				<p className="mb-2 flex items-center gap-1.5 text-sm text-neutral-500">
					<Sparkles aria-hidden className="h-3.5 w-3.5" />
					{summary ? "AI Summary" : "Kite"}
				</p>
				{summary && (
					<div data-suggestion-summary className="mb-3 border-b border-blue-200 pb-3 last:mb-0 last:border-0 last:pb-0">
						<div className="flex items-start justify-between gap-2">
							<p className="whitespace-pre-line text-neutral-800">{summaryText(summary)}</p>
							<SuggestionCardMenu suggestion={summary} onChanged={onChanged} />
						</div>
						<WhyDisclosure suggestion={summary} />
					</div>
				)}
				{answered && <ModuleBlock answered suggestion={answered} onChanged={onChanged} />}
				{blocks.map((suggestion) =>
					suggestion.kind === "reply" ? (
						<ReplyBlock key={suggestion.id} suggestion={suggestion} onChanged={onChanged} />
					) : suggestionKindModule(suggestion.kind) ? (
						<ModuleBlock key={suggestion.id} suggestion={suggestion} onChanged={onChanged} />
					) : (
						<PhishingBlock
							key={suggestion.id}
							suggestion={suggestion}
							onChanged={onChanged}
							menu={<SuggestionCardMenu suggestion={suggestion} onChanged={onChanged} />}
							why={<WhyDisclosure suggestion={suggestion} />}
						/>
					),
				)}
			</section>
		</div>
	);
}
