"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { htmlToPlainText } from "@/components/compose/rich-text-utils";
import { useSuggestionList } from "@/hooks/use-suggestion-list";
import type { OpenSuggestion } from "@/hooks/open-suggestions-types";
import { useT } from "@/lib/i18n/use-t";
import { authFetch } from "@/lib/auth/client";
import { getEmailAddress, getEmailDisplayName } from "@/lib/email/address";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import { suggestionKindModule } from "@/components/modules/client-registry";
import { runCardAction } from "./suggestion-card-actions";
import { SuggestionBlock } from "./suggestion-card-body";
import type { CardSuggestion } from "./suggestion-card-types";
import { replyStatusText, summaryText, suggestionCardUrl } from "./suggestion-card-utils";
import { bodyText, PREVIEW_DRAFT_CHARS, PREVIEW_EXCERPT_CHARS, previewExcerpt } from "./suggestion-preview-utils";

/** A message's stored text, read once per message for five minutes (the reader's own endpoint, no HTML kept). */
function useMessageText(
	messageId: string | null,
	max: number = PREVIEW_EXCERPT_CHARS,
): { text: string | null; loading: boolean } {
	const query = useQuery({
		queryKey: ["suggestion-preview", "message", messageId],
		enabled: Boolean(messageId),
		staleTime: 5 * 60_000,
		retry: false,
		queryFn: async () => {
			const response = await authFetch(`/api/messages/${encodeURIComponent(messageId!)}`);
			if (!response.ok) throw new Error(`Message request failed (${response.status})`);
			const data = (await response.json()) as { body?: { textBody?: string | null; htmlBody?: string | null } };
			return bodyText(data.body, htmlToPlainText);
		},
	});
	return {
		text: query.data === undefined ? null : previewExcerpt(query.data, max),
		loading: query.isPending && !!messageId,
	};
}

function Quote({ children, label, testId }: { children: string; label: string; testId: string }) {
	return (
		<div data-testid={testId} className="mt-2">
			<p className="text-xs font-medium text-neutral-500">{label}</p>
			<p dir="auto" className="mt-0.5 line-clamp-6 whitespace-pre-line break-words text-sm text-neutral-700">
				{children}
			</p>
		</div>
	);
}

/** The suggestion's own content: the reader card's block for its kind, or the summary and title for the rest. */
function SuggestionBody({ suggestion, onChanged }: { suggestion: CardSuggestion; onChanged: () => void }) {
	const t = useT();
	const { text: draft } = useMessageText(
		suggestion.kind === "reply" && suggestion.canReviewDraft ? suggestion.draftId : null,
		PREVIEW_DRAFT_CHARS,
	);
	if (suggestion.kind === "summary")
		return (
			<p dir="auto" className="mt-3 whitespace-pre-line text-sm text-neutral-800">
				{summaryText(suggestion)}
			</p>
		);
	const hasBlock =
		suggestion.kind === "reply" || suggestion.kind === "phishing" || !!suggestionKindModule(suggestion.kind);
	return (
		<div
			data-preview-block
			className="mt-3 empty:hidden rounded-lg border border-indigo-400/50 bg-indigo-500/[0.04] p-3 text-sm"
		>
			{suggestion.kind === "reply" && draft && (
				<Quote label={t("Drafted reply")} testId="suggestion-preview-draft">
					{draft}
				</Quote>
			)}
			{hasBlock ? (
				<SuggestionBlock suggestion={suggestion} onChanged={onChanged} compact />
			) : (
				<p dir="auto" className="text-neutral-900">
					{suggestion.title}
				</p>
			)}
			{suggestion.kind === "reply" && !draft && (
				<p className="mt-1 text-xs text-neutral-500">{replyStatusText(suggestion)}</p>
			)}
		</div>
	);
}

/**
 * What the For you rows' hover preview shows once it opens (loaded on first open, so a row nobody hovers costs
 * nothing): who wrote it, the subject, a short excerpt of the message as plain text, then the suggestion's own
 * block from the reader's card, with its actions and confirmations unchanged, and Dismiss. The suggestion's
 * details come from the list the reader card shares and the excerpt from the message endpoint, each cached, so
 * moving the pointer between rows asks for nothing twice.
 */
export default function SuggestionPreviewContent({
	suggestion,
	mailbox,
	onClose,
}: {
	suggestion: OpenSuggestion;
	mailbox: string | null;
	onClose: () => void;
}) {
	const t = useT();
	const { data, reload } = useSuggestionList<{ suggestions?: CardSuggestion[] }>(
		suggestionCardUrl(suggestion.messageId, null),
	);
	const { text: excerpt, loading } = useMessageText(suggestion.messageId);
	const full = data?.suggestions?.find((item) => item.id === suggestion.id) ?? null;
	const from = suggestion.message.from;
	const href = suggestion.messageTarget.href;
	const changed = () => {
		reload();
		onClose();
	};

	return (
		<div data-suggestion-preview={suggestion.id}>
			<div className="flex items-baseline gap-2">
				<p dir="auto" className="min-w-0 truncate text-sm font-medium text-neutral-900">
					{from ? getEmailDisplayName(from) : t("Unknown sender")}
				</p>
				{from && getEmailDisplayName(from) !== getEmailAddress(from) && (
					<p dir="ltr" className="min-w-0 truncate text-xs text-neutral-500">
						{getEmailAddress(from)}
					</p>
				)}
			</div>
			{mailbox && <p className="truncate text-xs text-neutral-500">{mailbox}</p>}
			<p dir="auto" className="mt-1 text-sm font-medium text-neutral-900">
				{suggestion.message.subject || t("(no subject)")}
			</p>
			{excerpt ? (
				<Quote label={t("Message")} testId="suggestion-preview-excerpt">
					{excerpt}
				</Quote>
			) : (
				loading && <div className="mt-2 h-10 animate-pulse rounded bg-neutral-200/70" aria-hidden="true" />
			)}
			{full ? (
				<SuggestionBody suggestion={full} onChanged={changed} />
			) : data ? (
				<p className="mt-3 text-sm text-neutral-600">{t("This suggestion is no longer open.")}</p>
			) : (
				<div className="mt-3 h-16 animate-pulse rounded-lg bg-neutral-200/70" aria-hidden="true" />
			)}
			<div className="mt-3 flex items-center justify-between gap-2 border-t border-neutral-200 pt-2">
				{href && isSameOriginPath(href) ? (
					<Link
						href={href}
						className="text-xs font-medium text-blue-600 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
					>
						{t("Open message")}
					</Link>
				) : (
					<span />
				)}
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						void runCardAction({ id: suggestion.id, mailboxId: suggestion.mailboxId }, "dismiss").then(
							(done) => done && onClose(),
						);
					}}
				>
					{t("Dismiss")}
				</Button>
			</div>
		</div>
	);
}
