"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DriveItemDto } from "@/lib/drive/types";
import { DriveShareLinks } from "./drive-share-links";
import { DriveSharePeople } from "./drive-share-people";

/** Share an item: people on this install with view or edit, and (for the owner) public links. */
export function DriveShareDialog({
	item,
	onClose,
	onChanged,
}: {
	item: DriveItemDto;
	onClose: () => void;
	onChanged: () => void;
}) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="max-h-[calc(100vh-4rem)] w-[min(600px,calc(100vw-32px))] overflow-y-auto"
				data-drive-share
			>
				<DialogHeader>
					<DialogTitle className="truncate pr-8">Share “{item.name}”</DialogTitle>
					<DialogDescription>
						People you share with see it under Shared with me. Anyone with a public link can open it until the link
						expires or you revoke it.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-6">
					<DriveSharePeople itemId={item.id} onChanged={onChanged} />
					{item.role === "owner" && <DriveShareLinks itemId={item.id} onChanged={onChanged} />}
				</div>
			</DialogContent>
		</Dialog>
	);
}
