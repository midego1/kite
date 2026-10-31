"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { DriveItemDto } from "@/lib/drive/types";
import { bulkItems, type BulkAction } from "./drive-api";
import type { DriveDialog } from "./drive-types";
import { driveFileUrl, emailHref, folderHref, type DriveRowAction } from "./drive-utils";

const DONE: Record<Exclude<BulkAction, "move">, string> = {
	trash: "Moved to trash",
	restore: "Restored",
	delete: "Deleted forever",
};

function countText(count: number, noun = "item") {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What the row menus and the bulk bar do. Changes reload the listing through `onChanged`; anything
 * that needs a dialog opens it through `openDialog`.
 */
export function useDriveActions(openDialog: (dialog: DriveDialog) => void, onChanged: () => void) {
	const router = useRouter();
	const confirm = useConfirm();

	const runBulk = useCallback(
		async (items: DriveItemDto[], action: Exclude<BulkAction, "move">) => {
			if (!items.length) return;
			if (action === "delete") {
				const confirmed = await confirm({
					title: `Delete ${items.length === 1 ? `“${items[0].name}”` : countText(items.length)} forever?`,
					description: "Deleted files cannot be restored. Folders are deleted with everything in them.",
					confirmLabel: "Delete forever",
				});
				if (!confirmed) return;
			}
			try {
				const { count } = await bulkItems(
					items.map((item) => item.id),
					action,
				);
				toast.success(`${DONE[action]}: ${countText(count)}`);
				onChanged();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Something went wrong");
			}
		},
		[confirm, onChanged],
	);

	const open = useCallback(
		(item: DriveItemDto) => {
			if (item.kind === "folder") router.push(folderHref(item.id));
			else openDialog({ kind: "preview", item });
		},
		[openDialog, router],
	);

	const onRowAction = useCallback(
		(item: DriveItemDto, action: DriveRowAction) => {
			if (action === "open") return open(item);
			if (action === "download") return void window.location.assign(driveFileUrl(item, true));
			if (action === "open-email" && item.source) return router.push(emailHref(item.source));
			if (action === "save") return openDialog({ kind: "save", item });
			if (action === "share") return openDialog({ kind: "share", item });
			if (action === "rename") return openDialog({ kind: "rename", item });
			if (action === "move") return openDialog({ kind: "move", items: [item] });
			if (action === "trash" || action === "restore" || action === "delete") void runBulk([item], action);
		},
		[open, openDialog, router, runBulk],
	);

	return { onRowAction, runBulk, open };
}
