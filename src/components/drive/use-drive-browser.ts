"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import type { DriveItemDto } from "@/lib/drive/types";
import { bulkItems, driveRequest } from "./drive-api";
import type { DriveDialog } from "./drive-types";
import { isSelectable } from "./drive-utils";
import type { DriveRowDrag } from "./drive-item-row";

/** The selected rows, kept to those still listed after a reload, a move or a page change. */
export function useDriveSelection(items: readonly DriveItemDto[], resetKey: string) {
	const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
	const [seenKey, setSeenKey] = useState(resetKey);
	if (seenKey !== resetKey) {
		setSeenKey(resetKey);
		setIds(new Set());
	}
	const selectable = useMemo(() => items.filter(isSelectable), [items]);
	const selected = useMemo(() => selectable.filter((item) => ids.has(item.id)), [selectable, ids]);
	const toggle = useCallback(
		(id: string) =>
			setIds((current) => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			}),
		[],
	);
	const allSelected = selectable.length > 0 && selected.length === selectable.length;
	const toggleAll = useCallback(
		() => setIds(allSelected ? new Set() : new Set(selectable.map((item) => item.id))),
		[allSelected, selectable],
	);
	const clear = useCallback(() => setIds(new Set()), []);
	return { ids, selected, selectable, allSelected, toggle, toggleAll, clear };
}

export type DriveSelection = ReturnType<typeof useDriveSelection>;

/** `?file=<id>` (where Drive links point for a file) opens that file's preview once. */
export function useFileParam(openDialog: (dialog: DriveDialog) => void) {
	const params = useSearchParams();
	const router = useRouter();
	const fileId = params.get("file");
	useEffect(() => {
		if (!fileId) return;
		let cancelled = false;
		driveRequest<{ item: DriveItemDto }>(`/api/drive/items/${encodeURIComponent(fileId)}`, {}, "File not found")
			.then(({ item }) => {
				if (!cancelled) openDialog({ kind: "preview", item });
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : "File not found"))
			.finally(() => {
				if (!cancelled) router.replace(window.location.pathname);
			});
		return () => {
			cancelled = true;
		};
	}, [fileId, openDialog, router]);
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** Files dragged from the desktop onto the listing upload into it, when it takes uploads. */
export function useFileDropZone(enabled: boolean, onFiles: (files: File[]) => void) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const handlers = {
		onDragEnter: (event: DragEvent) => {
			if (!enabled || !hasFiles(event)) return;
			event.preventDefault();
			depth.current += 1;
			setOver(true);
		},
		onDragOver: (event: DragEvent) => {
			if (enabled && hasFiles(event)) event.preventDefault();
		},
		onDragLeave: () => {
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setOver(false);
		},
		onDrop: (event: DragEvent) => {
			if (!enabled || !hasFiles(event)) return;
			event.preventDefault();
			depth.current = 0;
			setOver(false);
			onFiles([...event.dataTransfer.files]);
		},
	};
	return { over, handlers };
}

const ROW_TYPE = "application/x-kite-drive-items";

/**
 * Rows dragged onto a folder row move there. Dragging a selected row carries the selection; a folder
 * never takes itself.
 */
export function useRowDrag(selected: readonly DriveItemDto[], onMoved: () => void) {
	const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
	const [dropId, setDropId] = useState<string | null>(null);

	const forItem = (item: DriveItemDto): DriveRowDrag => {
		const draggable = isSelectable(item) && !item.trashedAt;
		const takesDrop = item.kind === "folder" && draggable && !moving.has(item.id);
		return {
			draggable,
			moving: moving.has(item.id),
			dropActive: dropId === item.id,
			onDragStart: (event) => {
				const group = selected.some((entry) => entry.id === item.id) ? selected : [item];
				event.dataTransfer.setData(ROW_TYPE, JSON.stringify(group.map((entry) => entry.id)));
				event.dataTransfer.effectAllowed = "move";
				setMoving(new Set(group.map((entry) => entry.id)));
			},
			onDragEnd: () => {
				setMoving(new Set());
				setDropId(null);
			},
			drop: takesDrop
				? {
						onDragOver: (event) => {
							if (!event.dataTransfer.types.includes(ROW_TYPE)) return;
							event.preventDefault();
							setDropId(item.id);
						},
						onDragLeave: () => setDropId((current) => (current === item.id ? null : current)),
						onDrop: (event) => {
							const ids = JSON.parse(event.dataTransfer.getData(ROW_TYPE) || "[]") as string[];
							setDropId(null);
							if (!ids.length) return;
							event.preventDefault();
							bulkItems(ids, "move", item.id)
								.then(({ count }) => {
									toast.success(`Moved ${count} to ${item.name}`);
									onMoved();
								})
								.catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not move"));
						},
					}
				: undefined,
		};
	};

	return forItem;
}
