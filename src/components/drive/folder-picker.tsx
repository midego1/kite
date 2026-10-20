"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Folder, HardDrive } from "lucide-react";
import type { DriveCrumb, DriveItemDto } from "@/lib/drive/types";
import { driveRequest } from "./drive-api";

type FolderState = { key: string | null; folders: DriveItemDto[]; error: string | null };

/** The folders directly inside `folderId` (My Drive when null), loaded while `active`. */
function useFolders(folderId: string | null, active: boolean): FolderState & { loading: boolean } {
	const key = active ? (folderId ?? "") : null;
	const [state, setState] = useState<FolderState>({ key: null, folders: [], error: null });

	useEffect(() => {
		if (key === null) return;
		let cancelled = false;
		const search = new URLSearchParams({ view: "my", kind: "folder" });
		if (key) search.set("parent", key);
		driveRequest<{ items: DriveItemDto[] }>(`/api/drive/items?${search}`, {}, "Could not load your folders")
			.then(({ items }) => {
				if (!cancelled) setState({ key, folders: items, error: null });
			})
			.catch((error: unknown) => {
				if (!cancelled)
					setState({ key, folders: [], error: error instanceof Error ? error.message : "Could not load" });
			});
		return () => {
			cancelled = true;
		};
	}, [key]);

	return { ...state, loading: key !== null && state.key !== key };
}

function Breadcrumbs({ trail, onChange }: { trail: DriveCrumb[]; onChange: (trail: DriveCrumb[]) => void }) {
	return (
		<nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
			<button
				type="button"
				className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100"
				onClick={() => onChange([])}
			>
				<HardDrive className="h-4 w-4" />
				My Drive
			</button>
			{trail.map((crumb, index) => (
				<span key={crumb.id} className="flex items-center gap-1">
					<ChevronRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
					<button
						type="button"
						className="max-w-40 truncate rounded-md px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100"
						onClick={() => onChange(trail.slice(0, index + 1))}
					>
						{crumb.name}
					</button>
				</span>
			))}
		</nav>
	);
}

function FolderList({
	state,
	exclude,
	onOpen,
}: {
	state: FolderState & { loading: boolean };
	exclude: ReadonlySet<string>;
	onOpen: (folder: DriveItemDto) => void;
}) {
	if (state.loading) return <p className="px-3 py-2 text-sm text-neutral-500">Loading folders…</p>;
	if (state.error) return <p className="px-3 py-2 text-sm text-red-600">{state.error}</p>;
	const folders = state.folders.filter((folder) => !exclude.has(folder.id));
	if (!folders.length) return <p className="px-3 py-2 text-sm text-neutral-500">No folders here.</p>;
	return (
		<>
			{folders.map((folder) => (
				<button
					key={folder.id}
					type="button"
					className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
					onClick={() => onOpen(folder)}
				>
					<Folder className="h-4 w-4 shrink-0 text-amber-500" />
					<span className="min-w-0 flex-1 truncate">{folder.name}</span>
					<ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
				</button>
			))}
		</>
	);
}

/**
 * Browses your own folders from My Drive down. `trail` is the path to the chosen folder (empty for My Drive);
 * folders in `exclude` (what is being moved) are not offered, so nothing can be moved into itself.
 */
export function FolderPicker({
	trail,
	onTrailChange,
	active,
	exclude = new Set(),
}: {
	trail: DriveCrumb[];
	onTrailChange: (trail: DriveCrumb[]) => void;
	active: boolean;
	exclude?: ReadonlySet<string>;
}) {
	const state = useFolders(trail.at(-1)?.id ?? null, active);
	return (
		<>
			<Breadcrumbs trail={trail} onChange={onTrailChange} />
			<div className="min-h-32 rounded-lg border border-neutral-200 p-1" aria-busy={state.loading}>
				<FolderList
					state={state}
					exclude={exclude}
					onOpen={(folder) => onTrailChange([...trail, { id: folder.id, name: folder.name }])}
				/>
			</div>
		</>
	);
}
