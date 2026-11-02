import { authFetch } from "@/lib/auth/client";
import type { FolderMoveTarget, FolderUsage } from "@/lib/folders/manage-types";
import { FOLDERS_CHANGED_EVENT } from "@/components/messages/use-mailbox-folders";

export type FolderRequestResult = { ok: true } | { ok: false; error: string; status: number };

async function failure(response: Response, fallback: string): Promise<FolderRequestResult> {
	const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return { ok: false, status: response.status, error: typeof data?.error === "string" ? data.error : fallback };
}

/** What deleting the folder touches, or null when it cannot be read. */
export async function fetchFolderUsage(folderId: string): Promise<FolderUsage | null> {
	const response = await authFetch(`/api/folders/${encodeURIComponent(folderId)}`).catch(() => null);
	if (!response?.ok) return null;
	return (await response.json().catch(() => null)) as FolderUsage | null;
}

export async function renameFolder(folderId: string, name: string): Promise<FolderRequestResult> {
	const response = await authFetch(`/api/folders/${encodeURIComponent(folderId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	}).catch(() => null);
	if (!response) return { ok: false, status: 0, error: "Could not reach the server. Please try again." };
	if (!response.ok) return failure(response, "Could not rename the folder.");
	window.dispatchEvent(new Event(FOLDERS_CHANGED_EVENT));
	return { ok: true };
}

/** Deletes the folder after moving its messages; the list and the counts refresh when it succeeds. */
export async function deleteFolderRequest(
	folderId: string,
	moveTo: FolderMoveTarget | undefined,
): Promise<FolderRequestResult> {
	const response = await authFetch(`/api/folders/${encodeURIComponent(folderId)}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(moveTo ? { moveTo } : {}),
	}).catch(() => null);
	if (!response) return { ok: false, status: 0, error: "Could not reach the server. Please try again." };
	if (!response.ok) return failure(response, "Could not delete the folder.");
	window.dispatchEvent(new Event(FOLDERS_CHANGED_EVENT));
	window.dispatchEvent(new Event("kite:messages-changed"));
	return { ok: true };
}
