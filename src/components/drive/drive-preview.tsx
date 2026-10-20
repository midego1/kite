"use client";

import { Download, ExternalLink, Mail } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { previewKind } from "./drive-utils";

/** The file itself, same-origin: image, video, audio, or PDF and text in a frame; otherwise a download. */
export function DrivePreviewBody({
	src,
	downloadHref,
	contentType,
	name,
}: {
	src: string;
	downloadHref: string;
	contentType: string;
	name: string;
}) {
	const kind = previewKind(contentType);
	// User files are served by an authenticated route that the image optimizer cannot fetch.
	// eslint-disable-next-line @next/next/no-img-element
	if (kind === "image") return <img src={src} alt={name} className="mx-auto max-h-full max-w-full object-contain" />;
	if (kind === "video") return <video src={src} controls className="mx-auto max-h-full max-w-full" />;
	if (kind === "audio")
		return (
			<div className="flex h-full items-center justify-center">
				<audio src={src} controls />
			</div>
		);
	if (kind)
		return (
			<iframe src={src} title={name} className="h-full w-full rounded-lg bg-white" style={{ colorScheme: "light" }} />
		);
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-neutral-600">
			<p>There is no preview for this kind of file.</p>
			<a
				href={downloadHref}
				className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
			>
				<Download size={16} />
				Download
			</a>
		</div>
	);
}

export type PreviewTarget = {
	name: string;
	size: number;
	contentType: string;
	src: string;
	downloadHref: string;
	/** The message an attachment came from, when the file is one. */
	emailHref?: string;
};

export function DrivePreviewDialog({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="flex h-[min(85vh,900px)] w-[min(1100px,calc(100vw-32px))] max-w-none flex-col overflow-hidden p-0"
				data-drive-preview
			>
				<DialogTitle className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 pl-5 pr-14 text-base">
					<span className="min-w-0 flex-1 truncate font-medium">{target.name}</span>
					<span className="shrink-0 text-xs font-normal text-neutral-500">{formatDriveSize(target.size)}</span>
					{target.emailHref && (
						<a
							href={target.emailHref}
							className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-normal text-neutral-700 hover:bg-neutral-100"
						>
							<Mail size={16} />
							Open email
							<ExternalLink size={12} />
						</a>
					)}
					<a
						href={target.downloadHref}
						aria-label={`Download ${target.name}`}
						className="shrink-0 rounded-full p-2 text-neutral-700 hover:bg-neutral-100"
					>
						<Download size={18} />
					</a>
				</DialogTitle>
				<div className="min-h-0 flex-1 bg-neutral-50 p-3">
					<DrivePreviewBody
						src={target.src}
						downloadHref={target.downloadHref}
						contentType={target.contentType}
						name={target.name}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
