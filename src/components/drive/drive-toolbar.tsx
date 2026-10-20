"use client";

import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, Download, FolderInput, FolderPlus, FolderUp, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DRIVE_CATEGORIES, DRIVE_CATEGORY_LABELS, type DriveCategory } from "@/lib/drive/category-names-utils";
import type { DriveCrumb, DriveItemDto } from "@/lib/drive/types";
import type { DriveCommand } from "./drive-utils";
import { folderHref } from "./drive-utils";

export function DriveBreadcrumbs({ title, rootHref, path }: { title: string; rootHref: string; path: DriveCrumb[] }) {
	if (!path.length) return <h1 className="px-2 py-1 text-xl font-normal text-neutral-800 max-md:text-lg">{title}</h1>;
	return (
		<nav
			aria-label="Folder path"
			className="flex min-w-0 flex-wrap items-center gap-1 text-xl text-neutral-800 max-md:text-lg"
		>
			<Link href={rootHref} className="rounded-full px-2 py-1 hover:bg-neutral-100">
				{title}
			</Link>
			{path.map((crumb, index) => (
				<span key={crumb.id} className="flex min-w-0 items-center gap-1">
					<ChevronRight size={18} className="shrink-0 text-neutral-500" aria-hidden="true" />
					{index === path.length - 1 ? (
						<h1 className="truncate px-2 py-1 font-normal">{crumb.name}</h1>
					) : (
						<Link href={folderHref(crumb.id)} className="truncate rounded-full px-2 py-1 hover:bg-neutral-100">
							{crumb.name}
						</Link>
					)}
				</span>
			))}
		</nav>
	);
}

export function DriveCreateButtons({ onCommand }: { onCommand: (command: DriveCommand) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button type="button" size="sm" variant="outline" onClick={() => onCommand("new-folder")}>
				<FolderPlus size={16} className="mr-1.5" />
				New folder
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={() => onCommand("upload-files")}>
				<Upload size={16} className="mr-1.5" />
				Upload files
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={() => onCommand("upload-folder")}>
				<FolderUp size={16} className="mr-1.5" />
				Upload folder
			</Button>
		</div>
	);
}

export function DriveTypeChips({
	value,
	onChange,
}: {
	value: readonly DriveCategory[];
	onChange: (next: DriveCategory[]) => void;
}) {
	const toggle = (category: DriveCategory) =>
		onChange(value.includes(category) ? value.filter((entry) => entry !== category) : [...value, category]);
	return (
		<div role="group" aria-label="File types" className="flex flex-wrap gap-1.5">
			{DRIVE_CATEGORIES.map((category) => {
				const active = value.includes(category);
				return (
					<button
						key={category}
						type="button"
						aria-pressed={active}
						onClick={() => toggle(category)}
						className={clsx(
							"h-8 rounded-full border px-3 text-xs font-medium transition-colors",
							active
								? "border-blue-200 bg-blue-100 text-blue-900"
								: "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100",
						)}
					>
						{DRIVE_CATEGORY_LABELS[category]}
					</button>
				);
			})}
		</div>
	);
}

export type BulkHandlers = {
	onMove: () => void;
	onDownload: () => void;
	onTrash: () => void;
	onRestore: () => void;
	onDelete: () => void;
	onClear: () => void;
};

/** The selection's actions: in the trash restore and delete forever, elsewhere move, download and trash. */
export function DriveBulkBar({
	selected,
	inTrash,
	handlers,
}: {
	selected: DriveItemDto[];
	inTrash: boolean;
	handlers: BulkHandlers;
}) {
	const files = selected.filter((item) => item.kind === "file").length;
	return (
		<div
			role="toolbar"
			aria-label="Selected items"
			className="flex flex-wrap items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-sm text-blue-900"
		>
			<button
				type="button"
				onClick={handlers.onClear}
				aria-label="Clear selection"
				className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-blue-100"
			>
				<X size={16} />
			</button>
			<span className="pr-2">{selected.length} selected</span>
			{inTrash ? (
				<>
					<BulkButton icon={RotateCcw} label="Restore" onClick={handlers.onRestore} />
					<BulkButton icon={X} label="Delete forever" onClick={handlers.onDelete} />
				</>
			) : (
				<>
					<BulkButton icon={FolderInput} label="Move" onClick={handlers.onMove} />
					{files > 0 && <BulkButton icon={Download} label="Download" onClick={handlers.onDownload} />}
					<BulkButton icon={Trash2} label="Move to trash" onClick={handlers.onTrash} />
				</>
			)}
		</div>
	);
}

function BulkButton({ icon: Icon, label, onClick }: { icon: typeof X; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-8 items-center gap-1.5 rounded-full px-3 hover:bg-blue-100"
		>
			<Icon size={15} />
			{label}
		</button>
	);
}
