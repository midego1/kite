"use client";

import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import { createFolder } from "./drive-api";
import type { DriveUploadEntry } from "./drive-types";
import { UploadCancelled, uploadDriveFile } from "./drive-upload";
import { folderPathsOf, parentPathOf } from "./drive-utils";

type Queued = { id: string; file: File; parentId: string | null };

const relativePathOf = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";

/** Creates the folders a picked directory needs under `parentId`, and maps each path to its folder id. */
async function createFolderTree(files: File[], parentId: string | null): Promise<Map<string, string | null>> {
	const ids = new Map<string, string | null>([["", parentId]]);
	for (const path of folderPathsOf(files.map(relativePathOf))) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const { item } = await createFolder(name, ids.get(parentPathOf(path)) ?? parentId);
		ids.set(path, item.id);
	}
	return ids;
}

/**
 * The upload queue of the open listing: files go one at a time, each with its own progress and Cancel.
 * `onUploaded` runs once after a batch in which anything arrived.
 */
export function useDriveUploads(onUploaded: () => void) {
	const [uploads, setUploads] = useState<DriveUploadEntry[]>([]);
	const sequence = useRef(0);
	const controllers = useRef(new Map<string, AbortController>());
	const cancelledIds = useRef(new Set<string>());

	const patch = useCallback(
		(id: string, change: Partial<DriveUploadEntry>) =>
			setUploads((list) => list.map((entry) => (entry.id === id ? { ...entry, ...change } : entry))),
		[],
	);

	const runOne = useCallback(
		async ({ id, file, parentId }: Queued): Promise<boolean> => {
			const controller = new AbortController();
			controllers.current.set(id, controller);
			patch(id, { status: "uploading" });
			try {
				await uploadDriveFile(file, parentId, (percent, resumed) => patch(id, { percent, resumed }), controller.signal);
				patch(id, { status: "done", percent: 100 });
				return true;
			} catch (error) {
				if (error instanceof UploadCancelled) patch(id, { status: "cancelled" });
				else patch(id, { status: "failed", error: error instanceof Error ? error.message : "Upload failed" });
				return false;
			} finally {
				controllers.current.delete(id);
			}
		},
		[patch],
	);

	const enqueue = useCallback(
		async (queued: Queued[]) => {
			setUploads((list) => [
				...list,
				...queued.map(({ id, file }) => ({
					id,
					name: file.name,
					percent: 0,
					resumed: false,
					status: "queued" as const,
				})),
			]);
			let arrived = false;
			for (const entry of queued) {
				if (cancelledIds.current.delete(entry.id)) continue;
				arrived = (await runOne(entry)) || arrived;
			}
			if (arrived) onUploaded();
		},
		[onUploaded, runOne],
	);

	const nextId = () => `upload-${(sequence.current += 1)}`;

	const uploadFiles = useCallback(
		(files: File[], parentId: string | null) => {
			if (files.length) void enqueue(files.map((file) => ({ id: nextId(), file, parentId })));
		},
		[enqueue],
	);

	/** A picked directory: its folders first (shown at once), then its files into them. */
	const uploadFolder = useCallback(
		async (files: File[], parentId: string | null) => {
			if (!files.length) return;
			let folders: Map<string, string | null>;
			try {
				folders = await createFolderTree(files, parentId);
			} catch (error) {
				onUploaded();
				toast.error(error instanceof Error ? error.message : "Could not create the folders");
				return;
			}
			onUploaded();
			await enqueue(
				files.map((file) => ({
					id: nextId(),
					file,
					parentId: folders.get(parentPathOf(relativePathOf(file))) ?? parentId,
				})),
			);
		},
		[enqueue, onUploaded],
	);

	const cancel = useCallback(
		(id: string) => {
			const controller = controllers.current.get(id);
			if (controller) return controller.abort();
			cancelledIds.current.add(id);
			patch(id, { status: "cancelled" });
		},
		[patch],
	);

	const clearFinished = useCallback(
		() => setUploads((list) => list.filter((entry) => entry.status === "queued" || entry.status === "uploading")),
		[],
	);

	return { uploads, uploadFiles, uploadFolder, cancel, clearFinished };
}
