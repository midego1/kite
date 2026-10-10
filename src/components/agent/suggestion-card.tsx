"use client";

import dynamic from "next/dynamic";
import { useSuggestionList } from "@/hooks/use-suggestion-list";
import type { CardSuggestion, SuggestionCardProps } from "./suggestion-card-types";
import { cardSections, hasCardContent, suggestionCardUrl } from "./suggestion-card-utils";

const SuggestionCardBody = dynamic(() => import("./suggestion-card-body").then((module) => module.SuggestionCardBody), {
	ssr: false,
});

/**
 * Kite's suggestions for the open conversation, shown once above the thread. The list only covers
 * mailboxes where the user has full access, so everyone else gets nothing rather than a 404.
 */
export function SuggestionCard({ mailboxId, messageId, threadId }: SuggestionCardProps) {
	const { data, reload } = useSuggestionList<{ suggestions?: CardSuggestion[] }>(
		suggestionCardUrl(messageId, threadId),
	);
	const sections = cardSections(data?.suggestions ?? [], mailboxId);
	if (!hasCardContent(sections)) return null;
	return <SuggestionCardBody sections={sections} onChanged={reload} />;
}
