"use client";

import { formatAttachmentSize } from "@/app/(dashboard)/inbox/[messageId]/utils";
import type { MessageAttachmentCardProps } from "./message-attachment-card-types";
import { getAttachmentVisual } from "./message-attachment-card-utils";
import { MessageAttachmentMenu, useHasAttachmentSlots } from "./message-attachment-menu";

/** One attachment as Zero's chip: a coloured file-type icon, the name and the size; a click previews it. */
export function MessageAttachmentCard({ attachment, messageId, mailboxId, onPreview }: MessageAttachmentCardProps) {
	const visual = getAttachmentVisual(attachment);
	const Icon = visual.icon;
	const hasMenu = useHasAttachmentSlots();
	// The tile colours carry a background for the old large tiles; the chip only wants the icon colour.
	const iconColor = visual.iconClassName
		.split(" ")
		.filter((name) => name.startsWith("text-"))
		.join(" ");

	return (
		<div className="relative inline-flex max-w-full">
			<button
				type="button"
				onClick={() => onPreview(attachment)}
				title={`${attachment.filename} · ${visual.label}`}
				className={`flex h-9 max-w-full items-center gap-2 rounded-lg bg-neutral-100 pl-2.5 text-left text-sm transition-colors hover:bg-neutral-200 ${hasMenu ? "pr-10" : "pr-3"}`}
			>
				<Icon className={`h-4 w-4 shrink-0 ${iconColor}`} aria-hidden="true" />
				<span className="min-w-0 truncate text-neutral-900">{attachment.filename}</span>
				<span className="shrink-0 text-neutral-500">{formatAttachmentSize(attachment.size)}</span>
			</button>
			{hasMenu && (
				<MessageAttachmentMenu
					messageId={messageId}
					mailboxId={mailboxId}
					attachmentId={attachment.id}
					filename={attachment.filename}
				/>
			)}
		</div>
	);
}
