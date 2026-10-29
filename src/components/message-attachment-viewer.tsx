"use client";

import { ArrowDownToLine, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useReturnFocus } from "@/components/ui/use-return-focus";
import type { MessageAttachmentViewerProps } from "./message-attachment-viewer-types";
import { useAttachmentText } from "./use-attachment-text";
import { useObjectUrl } from "./use-object-url";
import { getAttachmentPreviewKind, getViewerUrls } from "./message-attachment-viewer-utils";

export function MessageAttachmentViewer({
	attachment,
	file = null,
	messageId,
	onOpenChange,
	open,
}: MessageAttachmentViewerProps) {
	// The viewer has no Trigger of its own, so focus goes back to the chip or menu button that opened it.
	const returnFocus = useReturnFocus();
	const previewKind = attachment ? getAttachmentPreviewKind(attachment) : "unsupported";
	const fileUrl = useObjectUrl(open ? file : null);
	const { previewUrl, downloadUrl } = getViewerUrls(attachment, messageId, file ? fileUrl : null);
	const { content: textContent, error: textError } = useAttachmentText({
		enabled: open && !!attachment && previewKind === "text",
		file,
		url: previewUrl,
	});

	if (!attachment) return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				{...returnFocus}
				className="flex h-[min(88vh,900px)] w-[min(1100px,calc(100vw-32px))] flex-col overflow-hidden"
			>
				<DialogHeader className="shrink-0 pr-10">
					<DialogTitle className="truncate">{attachment.filename}</DialogTitle>
					<DialogDescription>{attachment.type}</DialogDescription>
				</DialogHeader>

				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-neutral-100">
					{previewKind === "image" && (
						<img src={previewUrl} alt={attachment.filename} className="max-h-full max-w-full object-contain" />
					)}
					{previewKind === "pdf" && (
						<iframe src={previewUrl} title={attachment.filename} className="h-full w-full border-0 bg-white" />
					)}
					{previewKind === "audio" && <audio src={previewUrl} controls className="w-[min(560px,90%)]" />}
					{previewKind === "video" && <video src={previewUrl} controls className="max-h-full max-w-full" />}
					{previewKind === "text" &&
						(textError || textContent ? (
							<pre className="h-full w-full overflow-auto whitespace-pre-wrap p-5 text-sm text-neutral-800">
								{textError || textContent}
							</pre>
						) : (
							<div className="h-full w-full space-y-3 bg-white p-5">
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-11/12" />
								<Skeleton className="h-4 w-4/5" />
							</div>
						))}
					{previewKind === "unsupported" && (
						<div className="flex flex-col items-center gap-3 px-6 text-center">
							<FileWarning className="h-10 w-10 text-neutral-400" />
							<p className="text-sm text-neutral-600">This file type cannot be previewed safely in the browser.</p>
						</div>
					)}
				</div>

				<div className="flex shrink-0 justify-end">
					{downloadUrl ? (
						<Button asChild>
							<a href={downloadUrl} download={attachment.filename}>
								<ArrowDownToLine className="h-4 w-4" />
								Download
							</a>
						</Button>
					) : (
						// A local file's copy is still being made.
						<Button disabled>
							<ArrowDownToLine className="h-4 w-4" />
							Download
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
