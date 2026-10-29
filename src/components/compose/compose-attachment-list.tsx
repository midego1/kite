"use client";

import { useEffect, useRef, useState } from "react";
import { MessageAttachmentViewer } from "@/components/message-attachment-viewer";
import { ComposeAttachmentChip } from "./compose-attachment-chip";
import type { ComposeAttachmentEntry, ComposeAttachmentListProps } from "./compose-attachment-types";
import { attachmentNotice, attachmentNoticeText, entryAttachment, entryKey } from "./compose-attachment-utils";

/**
 * The chips under the composer fields, for files stored on the draft (uploads, Forward) and for files not stored yet,
 * with the shared attachment viewer and a size notice that only shows when Cloudflare sends the message and the files near its budget.
 */
export function ComposeAttachmentList({
	draftId,
	localAttachments,
	storedAttachments,
	cloudThresholdBytes,
	cloudLinks,
	onRemoveLocal,
	onRemoveStored,
	onFocusFallback,
}: ComposeAttachmentListProps) {
	const [viewing, setViewing] = useState<ComposeAttachmentEntry | null>(null);
	const list = useRef<HTMLDivElement>(null);
	// Where focus goes once a removed chip is gone: the next chip, else the previous one, else the Attach button.
	const pendingFocus = useRef<{ removed: string; next: string | null } | null>(null);
	const fallback = useRef(onFocusFallback);
	useEffect(() => {
		fallback.current = onFocusFallback;
	});
	const entries: ComposeAttachmentEntry[] = [
		...storedAttachments.map((stored) => ({ kind: "stored" as const, id: stored.id, stored })),
		...localAttachments.map(({ id, file }) => ({ kind: "local" as const, id, file })),
	];
	const keys = entries.map(entryKey).join("|");

	useEffect(() => {
		const pending = pendingFocus.current;
		if (!pending || keys.split("|").includes(pending.removed)) return;
		pendingFocus.current = null;
		const chips = [...(list.current?.querySelectorAll<HTMLElement>("[data-compose-attachment-key]") ?? [])];
		const next = chips.find((chip) => chip.dataset.composeAttachmentKey === pending.next);
		next?.querySelector("button")?.focus();
	}, [keys]);

	// The last chip going away unmounts the list, so the Attach button takes the focus from here.
	useEffect(
		() => () => {
			if (pendingFocus.current && !pendingFocus.current.next) fallback.current();
		},
		[],
	);

	function remove(removed: ComposeAttachmentEntry) {
		const index = entries.findIndex((entry) => entryKey(entry) === entryKey(removed));
		const neighbour = entries[index + 1] ?? entries[index - 1];
		pendingFocus.current = { removed: entryKey(removed), next: neighbour ? entryKey(neighbour) : null };
		if (removed.kind === "stored") onRemoveStored(removed.id);
		else onRemoveLocal(removed.id);
	}

	if (entries.length === 0) return null;

	const notice = cloudLinks
		? attachmentNotice(
				entries.map((entry) => (entry.kind === "stored" ? entry.stored.size : entry.file.size)),
				cloudThresholdBytes,
			)
		: null;

	return (
		<div>
			<div
				ref={list}
				role="list"
				aria-label="Attachments"
				className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto overflow-y-hidden px-3 py-2"
			>
				{entries.map((entry) => (
					<div key={entryKey(entry)} role="listitem" className="flex shrink-0 max-w-full">
						<ComposeAttachmentChip entry={entry} draftId={draftId} onPreview={setViewing} onRemove={remove} />
					</div>
				))}
			</div>
			{notice && (
				<p className="px-3 pb-2 text-xs text-amber-700">{attachmentNoticeText(notice, cloudThresholdBytes)}</p>
			)}
			<MessageAttachmentViewer
				attachment={viewing ? entryAttachment(viewing, draftId) : null}
				messageId={draftId ?? ""}
				file={viewing?.kind === "local" ? viewing.file : null}
				open={!!viewing}
				onOpenChange={(open) => {
					if (!open) setViewing(null);
				}}
			/>
		</div>
	);
}
