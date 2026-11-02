"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { CustomFolder } from "@/components/dashboard-nav-types";

// Shared across toolbars so reopening a menu shows the folders immediately instead of popping in.
const cache = new Map<string, CustomFolder[]>();
/** Dispatched after a folder is created, renamed or deleted, so lists of several mailboxes' folders load it. */
export const FOLDERS_CHANGED_EVENT = "kite:folders-changed";

async function loadFolders(mailboxId: string): Promise<CustomFolder[]> {
	const response = await authFetch(`/api/folders?${new URLSearchParams({ mailboxId }).toString()}`);
	const data = (await response.json()) as { folders?: CustomFolder[] };
	const folders = data.folders ?? [];
	cache.set(mailboxId, folders);
	return folders;
}

export function useMailboxFolders(mailboxId: string | undefined): CustomFolder[] {
	const [fetched, setFetched] = useState<{ mailboxId: string; folders: CustomFolder[] } | null>(null);

	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;
		function load() {
			loadFolders(mailboxId!)
				.then((folders) => {
					if (!cancelled) setFetched({ mailboxId: mailboxId!, folders });
				})
				.catch(() => undefined);
		}
		load();
		// A folder renamed or deleted elsewhere in the app leaves menus listing the old set.
		window.addEventListener(FOLDERS_CHANGED_EVENT, load);
		return () => {
			cancelled = true;
			window.removeEventListener(FOLDERS_CHANGED_EVENT, load);
		};
	}, [mailboxId]);

	if (!mailboxId) return [];
	return fetched?.mailboxId === mailboxId ? fetched.folders : (cache.get(mailboxId) ?? []);
}

/** The folders of several mailboxes at once (the All mailboxes view), keyed by mailbox id. */
export function useFoldersByMailbox(mailboxIds: readonly string[]): Map<string, CustomFolder[]> {
	const key = mailboxIds.join(",");
	const [fetched, setFetched] = useState<{ key: string; folders: Map<string, CustomFolder[]> } | null>(null);

	useEffect(() => {
		const ids = key ? key.split(",") : [];
		if (ids.length === 0) return;
		let cancelled = false;
		function load() {
			void Promise.all(ids.map((id) => loadFolders(id).catch(() => cache.get(id) ?? []))).then((lists) => {
				if (!cancelled) setFetched({ key, folders: new Map(ids.map((id, index) => [id, lists[index]])) });
			});
		}
		load();
		window.addEventListener(FOLDERS_CHANGED_EVENT, load);
		return () => {
			cancelled = true;
			window.removeEventListener(FOLDERS_CHANGED_EVENT, load);
		};
	}, [key]);

	if (fetched?.key === key) return fetched.folders;
	return new Map(mailboxIds.map((id) => [id, cache.get(id) ?? []]));
}
