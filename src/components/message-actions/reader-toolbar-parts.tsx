"use client";

import clsx from "clsx";
import { Archive, Forward, Mail, MailOpen, Reply, ReplyAll, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { OVERFLOW_FIXED_ATTR, OVERFLOW_ID_ATTR } from "./use-reader-toolbar-overflow";
import type { ReplyMode } from "./types";
import { useT } from "@/lib/i18n/use-t";

export const MORE_ITEM_CLASS =
	"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3 disabled:text-neutral-400";

/**
 * One action of the reader toolbar's row. An action that has overflowed stays rendered, but invisible and out of
 * flow, so its natural width can still be measured; `fixed` marks what never moves (More actions, Delete).
 */
export function ToolbarSlot({
	id,
	visible = true,
	fixed,
	children,
}: {
	id?: string;
	visible?: boolean;
	fixed?: boolean;
	children: ReactNode;
}) {
	const marker = fixed ? { [OVERFLOW_FIXED_ATTR]: "" } : { [OVERFLOW_ID_ATTR]: id };
	return (
		<span {...marker} className={clsx("inline-flex shrink-0", !visible && "pointer-events-none invisible absolute")}>
			{children}
		</span>
	);
}

type LeadItemsProps = {
	isMobile: boolean;
	/** Whether a toolbar action moved into the menu because the row had no room for it. */
	overflowed: (id: string) => boolean;
	canReplyAll: boolean;
	canForward: boolean;
	read: boolean;
	disabled: boolean;
	archiveDisabled: boolean;
	spamDisabled: boolean;
	onReply: (mode: ReplyMode) => void;
	onForward: () => void;
	onAction: (action: BulkMessageAction) => void;
};

/** The first entries of "More actions": on a phone the ones the row never holds, and on any width whichever of the
 * row's actions did not fit. */
export function ReaderMoreLeadItems(props: LeadItemsProps) {
	const t = useT();
	const { isMobile, overflowed, read } = props;
	const showArchive = isMobile || overflowed("archive");
	const showReplyAll = props.canReplyAll && (isMobile || overflowed("replyAll"));
	const showMark = isMobile || overflowed("mark");
	const any = showArchive || showReplyAll || showMark || ["reply", "spam"].some(overflowed);
	return (
		<>
			{overflowed("reply") && (
				<button
					type="button"
					className={MORE_ITEM_CLASS}
					disabled={props.disabled}
					onClick={() => props.onReply("reply")}
				>
					<Reply className="h-4 w-4 rtl:-scale-x-100" />
					{t("Reply")}
				</button>
			)}
			{showArchive && (
				<button
					type="button"
					className={MORE_ITEM_CLASS}
					disabled={props.archiveDisabled}
					onClick={() => props.onAction("archive")}
				>
					<Archive className="h-4 w-4" />
					{t("Archive")}
				</button>
			)}
			{showReplyAll && (
				<button type="button" className={MORE_ITEM_CLASS} onClick={() => props.onReply("replyAll")}>
					<ReplyAll className="h-4 w-4 rtl:-scale-x-100" />
					{t("Reply all")}
				</button>
			)}
			{isMobile && props.canForward && (
				<button type="button" className={MORE_ITEM_CLASS} onClick={props.onForward}>
					<Forward className="h-4 w-4 rtl:-scale-x-100" />
					{t("Forward")}
				</button>
			)}
			{showMark && (
				<button type="button" className={MORE_ITEM_CLASS} onClick={() => props.onAction(read ? "unread" : "read")}>
					{read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
					{read ? t("Mark as unread") : t("Mark as read")}
				</button>
			)}
			{overflowed("spam") && (
				<button
					type="button"
					className={MORE_ITEM_CLASS}
					disabled={props.spamDisabled}
					onClick={() => props.onAction("spam")}
				>
					<ShieldAlert className="h-4 w-4" />
					{t("Report spam")}
				</button>
			)}
			{any && <hr className="my-1 border-neutral-100" />}
		</>
	);
}
