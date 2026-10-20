"use client";

import clsx from "clsx";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
	Download,
	Eye,
	FolderInput,
	HardDrive,
	Mail,
	MoreVertical,
	Pencil,
	RotateCcw,
	Share2,
	Trash2,
	X,
	type LucideIcon,
} from "lucide-react";
import type { DragEvent } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import type { DriveItemDto } from "@/lib/drive/types";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { driveIconFor } from "./drive-icons";
import { driveRowActions, formatDriveDate, type DriveRowAction } from "./drive-utils";

const ACTION_META: Record<DriveRowAction, { label: string; icon: LucideIcon; danger?: boolean }> = {
	open: { label: "Open", icon: Eye },
	download: { label: "Download", icon: Download },
	"open-email": { label: "Open email", icon: Mail },
	save: { label: "Save to Drive", icon: HardDrive },
	share: { label: "Share", icon: Share2 },
	rename: { label: "Rename", icon: Pencil },
	move: { label: "Move", icon: FolderInput },
	trash: { label: "Move to trash", icon: Trash2 },
	restore: { label: "Restore", icon: RotateCcw },
	delete: { label: "Delete forever", icon: X, danger: true },
};

const menuItemClass =
	"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";

export const DRIVE_GRID =
	"grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-x-4 md:grid-cols-[2rem_minmax(0,1fr)_10rem_8rem_6rem_2.5rem]";

function RowMenu({ item, onAction }: { item: DriveItemDto; onAction: (action: DriveRowAction) => void }) {
	const actions = driveRowActions(item);
	if (!actions.length) return <span />;
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label={`Actions for ${item.name}`}
					className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
				>
					<MoreVertical size={16} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={4}
					className="z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl"
				>
					{actions.map((action) => {
						const { label, icon: Icon, danger } = ACTION_META[action];
						return (
							<DropdownMenu.Item
								key={action}
								className={clsx(menuItemClass, danger && "text-red-600")}
								onSelect={() => onAction(action)}
							>
								<Icon size={16} />
								{label}
							</DropdownMenu.Item>
						);
					})}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

function ownerLabel(item: DriveItemDto): string {
	if (item.source) return item.ownerName;
	return item.role === "owner" ? "me" : item.ownerName;
}

export type DriveRowDrag = {
	draggable: boolean;
	onDragStart: (event: DragEvent) => void;
	onDragEnd: () => void;
	/** Set on folders that accept a drop of the dragged rows. */
	drop?: { onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void };
	dropActive: boolean;
	moving: boolean;
};

/** One listing row: select, name (opens), owner, modified, size and the row menu. */
export function DriveItemRow({
	item,
	selected,
	selectable,
	onToggle,
	onAction,
	drag,
}: {
	item: DriveItemDto;
	selected: boolean;
	selectable: boolean;
	onToggle: () => void;
	onAction: (action: DriveRowAction) => void;
	drag: DriveRowDrag;
}) {
	const { Icon, className } = driveIconFor(item);
	return (
		<div
			role="row"
			data-drive-item={item.name}
			draggable={drag.draggable}
			onDragStart={drag.onDragStart}
			onDragEnd={drag.onDragEnd}
			{...drag.drop}
			className={clsx(
				DRIVE_GRID,
				"group rounded-lg px-3 text-sm",
				drag.dropActive
					? "bg-blue-100 ring-2 ring-inset ring-blue-500"
					: selected
						? "bg-blue-50"
						: "hover:bg-neutral-50",
				drag.moving && "opacity-50",
			)}
		>
			<Checkbox
				checked={selected}
				onChange={onToggle}
				disabled={!selectable}
				aria-label={`Select ${item.name}`}
				className={clsx("ml-1", !selectable && "invisible")}
			/>
			<button
				type="button"
				onClick={() => onAction("open")}
				disabled={!!item.trashedAt}
				className="flex min-w-0 items-center gap-3 py-3 text-left disabled:cursor-default"
			>
				<Icon
					size={16}
					className={clsx("shrink-0", className)}
					fill={item.kind === "folder" ? "currentColor" : "none"}
				/>
				<span className="truncate text-neutral-900">{item.name}</span>
				{item.shared && item.role === "owner" && (
					<Share2 size={12} className="shrink-0 text-neutral-400" aria-label="Shared" />
				)}
			</button>
			<span className="hidden truncate text-neutral-600 md:block">{ownerLabel(item)}</span>
			<span className="hidden text-neutral-600 md:block">{formatDriveDate(item.trashedAt ?? item.updatedAt)}</span>
			<span className="hidden text-neutral-600 md:block">
				{item.kind === "file" ? formatDriveSize(item.size) : "-"}
			</span>
			<RowMenu item={item} onAction={onAction} />
		</div>
	);
}
