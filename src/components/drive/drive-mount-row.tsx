"use client";

import clsx from "clsx";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, Eye, FolderInput, FolderOpen, MoreVertical, Pencil, X, type LucideIcon } from "lucide-react";
import type { DriveMountItemDto } from "@/lib/drive/types";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { driveIconFor } from "./drive-icons";
import { formatDriveDate } from "./drive-utils";

export type MountRowAction = "open" | "download" | "rename" | "move" | "delete";

const ACTIONS: Record<MountRowAction, { label: string; icon: LucideIcon; danger?: boolean }> = {
	open: { label: "Open", icon: Eye },
	download: { label: "Download", icon: Download },
	rename: { label: "Rename", icon: Pencil },
	move: { label: "Move", icon: FolderInput },
	delete: { label: "Delete", icon: X, danger: true },
};

const actionsFor = (item: DriveMountItemDto): MountRowAction[] =>
	item.kind === "folder" ? ["open", "rename", "move", "delete"] : ["open", "download", "rename", "move", "delete"];

const menuItemClass =
	"flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";

/** Name, modified, size and the menu; the extra columns appear from the listing's own `@2xl` width. */
export const MOUNT_GRID =
	"grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-4 @2xl:grid-cols-[minmax(0,1fr)_10rem_6rem_2.5rem]";

function RowMenu({ item, onAction }: { item: DriveMountItemDto; onAction: (action: MountRowAction) => void }) {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label={`Actions for ${item.name}`}
					className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 pointer-coarse:h-11 pointer-coarse:w-11"
				>
					<MoreVertical size={16} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={4}
					className="z-[200] min-w-48 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					{actionsFor(item).map((action) => {
						const { label, icon: Icon, danger } = ACTIONS[action];
						return (
							<DropdownMenu.Item
								key={action}
								className={clsx(menuItemClass, danger && "text-red-600")}
								onSelect={() => onAction(action)}
							>
								{action === "open" && item.kind === "folder" ? <FolderOpen size={16} /> : <Icon size={16} />}
								{label}
							</DropdownMenu.Item>
						);
					})}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/** One row of a linked folder's listing. */
export function DriveMountRow({
	item,
	onAction,
}: {
	item: DriveMountItemDto;
	onAction: (action: MountRowAction) => void;
}) {
	const { Icon, className } = driveIconFor({ ...item, contentType: item.contentType ?? "" });
	return (
		<div
			role="row"
			data-drive-item={item.name}
			className={clsx(MOUNT_GRID, "rounded-lg px-3 text-sm hover:bg-neutral-50")}
		>
			<button
				type="button"
				onClick={() => onAction("open")}
				className="flex min-w-0 items-center gap-3 py-3 text-start"
			>
				<Icon
					size={16}
					className={clsx("shrink-0", className)}
					fill={item.kind === "folder" ? "currentColor" : "none"}
				/>
				<span className="truncate text-neutral-900">{item.name}</span>
			</button>
			<span className="hidden text-neutral-600 @2xl:block">
				{item.updatedAt ? formatDriveDate(item.updatedAt) : "-"}
			</span>
			<span className="hidden text-neutral-600 @2xl:block">
				{item.kind === "file" ? formatDriveSize(item.size) : "-"}
			</span>
			<RowMenu item={item} onAction={onAction} />
		</div>
	);
}
