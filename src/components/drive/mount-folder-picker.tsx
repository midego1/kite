"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderSymlink } from "lucide-react";
import type { DriveMountItemDto } from "@/lib/drive/types";
import { listMountItems } from "./drive-mounts-api";

type FolderState = { key: string | null; folders: DriveMountItemDto[]; error: string | null };

/** The folders directly inside `path` of a linked folder, loaded while `active`. */
function useMountFolders(mountId: string, path: string, active: boolean) {
	const key = active ? `${mountId}\u0000${path}` : null;
	const [state, setState] = useState<FolderState>({ key: null, folders: [], error: null });
	useEffect(() => {
		if (key === null) return;
		let cancelled = false;
		listMountItems(mountId, path)
			.then(({ items }) => {
				if (!cancelled) setState({ key, folders: items.filter((item) => item.kind === "folder"), error: null });
			})
			.catch((error: unknown) => {
				if (!cancelled)
					setState({ key, folders: [], error: error instanceof Error ? error.message : "Could not load" });
			});
		return () => {
			cancelled = true;
		};
	}, [key, mountId, path]);
	return { ...state, loading: key !== null && state.key !== key };
}

const segmentsOf = (path: string) => path.split("/").filter(Boolean);
const pathOf = (segments: string[]) => `/${segments.join("/")}`;

/**
 * Browses the folders of one linked folder from its top down. `path` is the chosen folder (`/` for the linked
 * folder itself); folders in `exclude` (what is being moved) are not offered, so nothing moves into itself.
 */
export function MountFolderPicker({
	mountId,
	label,
	path,
	onPathChange,
	active,
	exclude,
}: {
	mountId: string;
	label: string;
	path: string;
	onPathChange: (path: string) => void;
	active: boolean;
	exclude?: string;
}) {
	const state = useMountFolders(mountId, path, active);
	const segments = segmentsOf(path);
	const folders = state.folders.filter((folder) => folder.path !== exclude);
	return (
		<>
			<nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
				<button
					type="button"
					className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100"
					onClick={() => onPathChange("/")}
				>
					<FolderSymlink className="h-4 w-4" />
					{label}
				</button>
				{segments.map((segment, index) => (
					<span key={pathOf(segments.slice(0, index + 1))} className="flex items-center gap-1">
						<ChevronRight className="h-3.5 w-3.5 text-neutral-400 rtl:-scale-x-100" aria-hidden="true" />
						<button
							type="button"
							className="max-w-40 truncate rounded-md px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100"
							onClick={() => onPathChange(pathOf(segments.slice(0, index + 1)))}
						>
							{segment}
						</button>
					</span>
				))}
			</nav>
			<div className="min-h-32 rounded-lg border border-neutral-200 p-1" aria-busy={state.loading}>
				{state.loading ? (
					<p className="px-3 py-2 text-sm text-neutral-500">Loading folders…</p>
				) : state.error ? (
					<p className="px-3 py-2 text-sm text-red-600">{state.error}</p>
				) : !folders.length ? (
					<p className="px-3 py-2 text-sm text-neutral-500">No folders here.</p>
				) : (
					folders.map((folder) => (
						<button
							key={folder.path}
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100"
							onClick={() => onPathChange(folder.path)}
						>
							<Folder className="h-4 w-4 shrink-0 text-amber-500" />
							<span className="min-w-0 flex-1 truncate">{folder.name}</span>
							<ChevronRight className="h-4 w-4 shrink-0 text-neutral-400 rtl:-scale-x-100" aria-hidden="true" />
						</button>
					))
				)}
			</div>
		</>
	);
}
