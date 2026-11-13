"use client";

import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import { DownloadAllAttachmentsButton } from "@/components/download-all-attachments-button";
import { MessageAttachmentCard } from "@/components/message-attachment-card";
import { useT } from "@/lib/i18n/use-t";

/** The open message's attachment chips under their heading, with "Download all" once there are two or more. */
export function MessageAttachmentsSection({
	attachments,
	messageId,
	mailboxId,
	onPreview,
}: {
	attachments: MessageAttachment[];
	messageId: string;
	mailboxId: string | null;
	onPreview: (attachment: MessageAttachment) => void;
}) {
	const t = useT();
	if (!attachments.length) return null;
	return (
		<section className="mt-6">
			<div className="mb-2 flex items-center gap-3">
				<h2 className="text-sm text-neutral-500">{t("Attachments ({count})", { count: attachments.length })}</h2>
				{attachments.length > 1 && <DownloadAllAttachmentsButton messageId={messageId} />}
			</div>
			<div className="flex flex-wrap gap-2">
				{attachments.map((attachment) => (
					<MessageAttachmentCard
						key={attachment.id}
						attachment={attachment}
						messageId={messageId}
						mailboxId={mailboxId}
						onPreview={onPreview}
					/>
				))}
			</div>
		</section>
	);
}
