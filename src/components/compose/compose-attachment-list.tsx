"use client";

import { useState } from "react";
import { MessageAttachmentViewer } from "@/components/message-attachment-viewer";
import { ComposeAttachmentChip } from "./compose-attachment-chip";
import type { ComposeAttachmentEntry, ComposeAttachmentListProps } from "./compose-attachment-types";
import { attachmentNotice, attachmentNoticeText, entryAttachment } from "./compose-attachment-utils";

/**
 * The chips under the composer fields, for files stored on the draft (uploads, Forward) and for files not stored yet,
 * with the shared attachment viewer and a size notice that only shows when the files near Cloudflare's message budget.
 */
export function ComposeAttachmentList({
	draftId,
	localAttachments,
	storedAttachments,
	cloudThresholdBytes,
	onRemoveLocal,
	onRemoveStored,
}: ComposeAttachmentListProps) {
	const [viewing, setViewing] = useState<ComposeAttachmentEntry | null>(null);
	const entries: ComposeAttachmentEntry[] = [
		...storedAttachments.map((stored) => ({ kind: "stored" as const, id: stored.id, stored })),
		...localAttachments.map(({ id, file }) => ({ kind: "local" as const, id, file })),
	];
	if (entries.length === 0) return null;

	const notice = attachmentNotice(
		entries.map((entry) => (entry.kind === "stored" ? entry.stored.size : entry.file.size)),
		cloudThresholdBytes,
	);

	return (
		<div>
			<div
				role="list"
				aria-label="Attachments"
				className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto overflow-y-hidden px-3 py-2"
			>
				{entries.map((entry) => (
					<div key={`${entry.kind}-${entry.id}`} role="listitem" className="flex shrink-0 max-w-full">
						<ComposeAttachmentChip
							entry={entry}
							draftId={draftId}
							onPreview={setViewing}
							onRemove={(removed) =>
								removed.kind === "stored" ? onRemoveStored(removed.id) : onRemoveLocal(removed.id)
							}
						/>
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
