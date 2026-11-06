"use client";

import Link from "next/link";
import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { SuggestionKindIcon } from "@/components/agent/suggestion-badge";
import { runCardAction } from "@/components/agent/suggestion-card-actions";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { formatMessageListTimestamp } from "@/components/messages/utils";
import { useT } from "@/lib/i18n/use-t";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import {
	COMMAND_CENTER_LINK_CLASS,
	COMMAND_CENTER_LINK_ROW_CLASS,
	COMMAND_CENTER_LIST_CLASS,
	COMMAND_CENTER_ROW_CLASS,
	CommandCenterCard,
	CommandCenterEmpty,
} from "./command-center-card";
import { forYouCardView, type ForYouCardRow } from "./for-you-card-utils";

const ROW_CLASS = "min-h-12 flex-1 py-1.5";

function ForYouCardEntry({
	row,
	dismissing,
	onDismiss,
}: {
	row: ForYouCardRow;
	dismissing: boolean;
	onDismiss: () => void;
}) {
	const t = useT();
	const body = (
		<>
			<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
				<SuggestionKindIcon kind={row.kind} className="h-3.5 w-3.5" />
			</span>
			<span className="min-w-0 flex-1">
				<span dir="auto" className="block truncate text-neutral-900">
					{row.subject}
				</span>
				<span dir="auto" className="block truncate text-xs text-neutral-500">
					{[row.kindLabel, row.sender].filter(Boolean).join(" · ")}
				</span>
			</span>
			<time dateTime={row.createdAt} className="shrink-0 text-xs text-neutral-500 @max-[26rem]:hidden">
				{formatMessageListTimestamp(row.createdAt)}
			</time>
		</>
	);
	return (
		<li className="flex items-center gap-1" data-for-you-card-entry={row.id} data-kind={row.kind}>
			{row.href && isSameOriginPath(row.href) ? (
				<Link href={row.href} className={`${COMMAND_CENTER_LINK_ROW_CLASS} ${ROW_CLASS}`}>
					{body}
				</Link>
			) : (
				<div className={`${COMMAND_CENTER_ROW_CLASS} ${ROW_CLASS}`}>{body}</div>
			)}
			<button
				type="button"
				disabled={dismissing}
				onClick={onDismiss}
				aria-label={t("Dismiss {subject}", { subject: row.subject })}
				title={t("Dismiss")}
				className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</li>
	);
}

/**
 * The command center's For you card: the newest open suggestions of the mailboxes in view, each with its kind, the
 * subject, the sender and a Dismiss that works like the reader card's (with Undo), and a link to the For you page.
 * It reads the list the sidebar item and the For you page share (refreshed by the same events), or for one
 * mailbox in view that mailbox's own list through the same store, and it is hidden whenever the sidebar item is. The count that used to be a tile
 * is in its header.
 */
export function ForYouCard() {
	const t = useT();
	const { viewMailboxes } = useSelectedMailbox();
	// One mailbox in view asks for that mailbox's own list: the shared one stops at 200 rows across every mailbox,
	// which other mailboxes could fill. Several in view use the shared list the sidebar already loaded.
	const suggestions = useOpenSuggestions(viewMailboxes.length === 1 ? viewMailboxes[0].id : undefined);
	const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());
	const view = forYouCardView(
		suggestions,
		viewMailboxes.map((mailbox) => mailbox.id),
	);
	if (!view.visible) return null;

	async function dismiss(row: ForYouCardRow) {
		setDismissing((current) => new Set(current).add(row.id));
		await runCardAction({ id: row.id, mailboxId: row.mailboxId }, "dismiss");
		setDismissing((current) => {
			const next = new Set(current);
			next.delete(row.id);
			return next;
		});
	}

	return (
		<CommandCenterCard
			title={t("For you")}
			icon={Sparkles}
			count={view.count}
			action={{ label: t("Open For you"), href: "/for-you" }}
			testId="command-center-for-you"
		>
			{view.rows.length === 0 ? (
				<CommandCenterEmpty icon={Sparkles} action={{ label: t("Open For you"), href: "/for-you" }}>
					{t("Nothing for you right now.")}
				</CommandCenterEmpty>
			) : (
				<ul className={COMMAND_CENTER_LIST_CLASS}>
					{view.rows.map((row) => (
						<ForYouCardEntry
							key={row.id}
							row={row}
							dismissing={dismissing.has(row.id)}
							onDismiss={() => void dismiss(row)}
						/>
					))}
				</ul>
			)}
			{view.more > 0 && (
				<Link href="/for-you" className={`mt-2 block w-fit px-2 ${COMMAND_CENTER_LINK_CLASS}`}>
					{t("{count} more", { count: view.more })}
				</Link>
			)}
		</CommandCenterCard>
	);
}
