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
	if (!path.length) return <h1 className="truncate px-1 text-base font-medium text-neutral-900">{title}</h1>;
	return (
		<nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-0.5 text-base text-neutral-500">
			<Link href={rootHref} className="rounded-md px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-900">
				{title}
			</Link>
			{path.map((crumb, index) => (
				<span key={crumb.id} className="flex min-w-0 items-center gap-1">
					<ChevronRight size={16} className="shrink-0 text-neutral-400" aria-hidden="true" />
					{index === path.length - 1 ? (
						<h1 className="truncate px-1.5 py-0.5 font-medium text-neutral-900">{crumb.name}</h1>
					) : (
						<Link
							href={folderHref(crumb.id)}
							className="truncate rounded-md px-1.5 py-0.5 hover:bg-neutral-100 hover:text-neutral-900"
						>
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
				<FolderPlus size={16} />
				New folder
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={() => onCommand("upload-files")}>
				<Upload size={16} />
				Upload files
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={() => onCommand("upload-folder")}>
				<FolderUp size={16} />
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
							"h-8 rounded-lg px-3 text-xs font-medium transition-colors",
							active
								? "bg-blue-600 text-white"
								: "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900",
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
			className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-200 bg-white px-1 py-0.5 text-sm text-neutral-900 shadow-xs"
		>
			<button
				type="button"
				onClick={handlers.onClear}
				aria-label="Clear selection"
				className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
			>
				<X size={16} />
			</button>
			<span className="pr-2 font-medium">{selected.length} selected</span>
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
			className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
		>
			<Icon size={15} />
			{label}
		</button>
	);
}
