"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef, useState } from "react";
import { ArrowDownToLine, Eye, MoreVertical, Trash2 } from "lucide-react";
import { useObjectUrl } from "@/components/use-object-url";
import { getAttachmentVisual } from "@/components/message-attachment-card-utils";
import { getAttachmentPreviewKind } from "@/components/message-attachment-viewer-utils";
import type { ComposeAttachmentChipProps } from "./compose-attachment-types";
import {
	canPreviewEntry,
	entryAttachment,
	entryKey,
	safeAttachmentUrl,
	splitFilename,
	storedDownloadUrl,
	storedThumbnailUrl,
} from "./compose-attachment-utils";
import { formatAttachmentSize } from "./utils";

const ITEM_CLASS =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";

const BLOB_URL_LIFETIME_MS = 60_000;

/** Downloads a file that is not stored yet from a copy of the browser's own bytes; a stored one uses the authenticated route. */
async function downloadLocalFile(file: File) {
	const copy = new Blob([await file.arrayBuffer()], { type: "application/octet-stream" });
	const url = URL.createObjectURL(copy);
	const link = document.createElement("a");
	link.href = safeAttachmentUrl(url);
	link.download = file.name;
	link.click();
	// Safari and Firefox start the download after the click returns, so the URL has to outlive it.
	setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
}

/**
 * One composer attachment as Zero's chip: a thumbnail for images or a coloured type icon, the name with its
 * extension kept visible, the size, and a "…" menu. Clicking the chip previews what the viewer can show and downloads
 * the rest, like the reader's attachment cards.
 */
export function ComposeAttachmentChip({ entry, draftId, onPreview, onRemove }: ComposeAttachmentChipProps) {
	const attachment = entryAttachment(entry, draftId);
	const visual = getAttachmentVisual(attachment);
	const Icon = visual.icon;
	const iconColor = visual.iconClassName
		.split(" ")
		.filter((name) => name.startsWith("text-"))
		.join(" ");
	const { base, extension } = splitFilename(attachment.filename);
	const previewable = canPreviewEntry(entry);
	const isImage = getAttachmentPreviewKind(attachment) === "image";
	const localUrl = useObjectUrl(entry.kind === "local" && isImage ? entry.file : null);
	const thumbnail = isImage ? localUrl || storedThumbnailUrl(entry, draftId) : null;
	const [thumbnailFailed, setThumbnailFailed] = useState(false);
	const downloadUrl = storedDownloadUrl(entry, draftId);
	// The viewer opens once the menu has closed: opening a modal dialog while the menu still holds the page's
	// pointer-events and focus lock leaves both stuck, so Preview waits for onCloseAutoFocus.
	const previewAfterClose = useRef(false);

	function download() {
		if (entry.kind === "local") return void downloadLocalFile(entry.file).catch(() => {});
		if (!downloadUrl) return;
		const link = document.createElement("a");
		link.href = safeAttachmentUrl(downloadUrl);
		link.download = attachment.filename;
		link.click();
	}

	function open() {
		if (previewable) onPreview(entry);
		else download();
	}

	return (
		<div
			data-compose-attachment={attachment.filename}
			data-compose-attachment-key={entryKey(entry)}
			data-compose-attachment-state={entry.kind === "stored" ? "saved" : "local"}
			className="flex h-9 max-w-64 shrink-0 items-center rounded-lg bg-neutral-100 text-sm transition-colors hover:bg-neutral-200"
		>
			<button
				type="button"
				onClick={open}
				aria-label={`${previewable ? "Preview" : "Download"} ${attachment.filename}, ${formatAttachmentSize(attachment.size)}`}
				title={`${attachment.filename} · ${visual.label}`}
				className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-lg pl-1.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
			>
				{thumbnail && !thumbnailFailed ? (
					<img
						src={safeAttachmentUrl(thumbnail)}
						alt=""
						onError={() => setThumbnailFailed(true)}
						className="h-7 w-7 shrink-0 rounded-md object-cover"
					/>
				) : (
					<span className="flex h-7 w-7 shrink-0 items-center justify-center">
						<Icon className={`h-4 w-4 ${iconColor}`} aria-hidden="true" />
					</span>
				)}
				<span className="flex min-w-0 text-neutral-900">
					<span className="truncate">{base}</span>
					{extension && <span className="shrink-0 text-neutral-500">{extension}</span>}
				</span>
				<span className="shrink-0 text-xs text-neutral-500">{formatAttachmentSize(attachment.size)}</span>
			</button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					aria-label={`More actions for ${attachment.filename}`}
					className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 outline-none hover:bg-neutral-200 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-600 data-[state=open]:bg-neutral-200"
				>
					<MoreVertical className="h-4 w-4" aria-hidden="true" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="end"
						sideOffset={4}
						collisionPadding={8}
						aria-label={`Actions for ${attachment.filename}`}
						onCloseAutoFocus={() => {
							if (!previewAfterClose.current) return;
							previewAfterClose.current = false;
							onPreview(entry);
						}}
						className="z-[130] min-w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
					>
						{previewable && (
							<DropdownMenu.Item
								className={ITEM_CLASS}
								onSelect={() => {
									previewAfterClose.current = true;
								}}
							>
								<Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
								Preview
							</DropdownMenu.Item>
						)}
						<DropdownMenu.Item className={ITEM_CLASS} onSelect={download}>
							<ArrowDownToLine className="h-4 w-4 shrink-0" aria-hidden="true" />
							Download
						</DropdownMenu.Item>
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item className={ITEM_CLASS} onSelect={() => onRemove(entry)}>
							<Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
							Remove
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}
