"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import type { DriveCrumb, DriveItemDto } from "@/lib/drive/types";
import type { AttachmentSlotContext } from "../client-registry-types";

type OverlayProps = AttachmentSlotContext & { open: boolean; onOpenChange: (open: boolean) => void };

type FolderState = { key: string | null; folders: DriveItemDto[]; error: string | null };

async function errorOf(response: Response, fallback: string): Promise<string> {
	const data = (await response.json().catch(() => null)) as { error?: string } | null;
	return data?.error || fallback;
}

/** The folders directly inside `folderId` (My Drive when null), loaded while the dialog is open. */
function useFolders(folderId: string | null, open: boolean): FolderState & { loading: boolean } {
	const key = open ? (folderId ?? "") : null;
	const [state, setState] = useState<FolderState>({ key: null, folders: [], error: null });

	useEffect(() => {
		if (key === null) return;
		let cancelled = false;
		const search = new URLSearchParams({ view: "my", kind: "folder" });
		if (key) search.set("parent", key);
		void authFetch(`/api/drive/items?${search}`)
			.then(async (response) => {
				if (!response.ok) throw new Error(await errorOf(response, "Could not load your folders"));
				const { items } = (await response.json()) as { items: DriveItemDto[] };
				if (!cancelled) setState({ key, folders: items, error: null });
			})
			.catch((error: unknown) => {
				if (!cancelled)
					setState({
						key,
						folders: [],
						error: error instanceof Error ? error.message : "Could not load your folders",
					});
			});
		return () => {
			cancelled = true;
		};
	}, [key]);

	return { ...state, loading: key !== null && state.key !== key };
}

/** Saves one mail attachment as a Drive file, into My Drive or a folder you pick. */
export function SaveAttachmentDialog({ attachmentId, open, onOpenChange }: OverlayProps) {
	const [trail, setTrail] = useState<DriveCrumb[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = trail.at(-1) ?? null;
	const { folders, loading, error: loadError } = useFolders(current?.id ?? null, open);

	function close(next: boolean) {
		if (!next) {
			setTrail([]);
			setError(null);
		}
		onOpenChange(next);
	}

	async function save() {
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch(`/api/drive/attachments/${encodeURIComponent(attachmentId)}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parentId: current?.id ?? null }),
			});
			if (!response.ok) {
				setError(await errorOf(response, "Could not save to Drive"));
				return;
			}
			toast.success(current ? `Saved to ${current.name}` : "Saved to My Drive");
			close(false);
		} catch {
			setError("Could not save to Drive");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md" data-drive-save-dialog>
				<DialogHeader>
					<DialogTitle>Save to Drive</DialogTitle>
					<DialogDescription>Choose the folder to save a copy of this attachment in.</DialogDescription>
				</DialogHeader>
				<nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
					<button
						type="button"
						className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100"
						onClick={() => setTrail([])}
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
								onClick={() => setTrail(trail.slice(0, index + 1))}
							>
								{crumb.name}
							</button>
						</span>
					))}
				</nav>
				<div className="min-h-32 rounded-lg border border-neutral-200 p-1" aria-busy={loading}>
					{loading && <p className="px-3 py-2 text-sm text-neutral-500">Loading folders…</p>}
					{!loading && loadError && <p className="px-3 py-2 text-sm text-red-600">{loadError}</p>}
					{!loading && !loadError && folders.length === 0 && (
						<p className="px-3 py-2 text-sm text-neutral-500">No folders here.</p>
					)}
					{!loading &&
						folders.map((folder) => (
							<button
								key={folder.id}
								type="button"
								className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
							>
								<Folder className="h-4 w-4 shrink-0 text-blue-600" />
								<span className="min-w-0 flex-1 truncate">{folder.name}</span>
								<ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
							</button>
						))}
				</div>
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button type="button" onClick={() => void save()} disabled={saving}>
						{saving ? "Saving…" : current ? `Save in ${current.name}` : "Save in My Drive"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
