import { authFetch } from "@/lib/auth/client";
import type { DriveItemDto } from "@/lib/drive/types";
import { DRIVE_REFRESH_EVENT } from "./drive-utils";

/** The server's `error` text, or the fallback when the answer has none. */
export async function driveError(response: Response, fallback: string): Promise<string> {
	const data = (await response.json().catch(() => null)) as { error?: string } | null;
	return data?.error || fallback;
}

/** A Drive API call that answers JSON; a failure throws with the server's message. */
export async function driveRequest<T>(
	url: string,
	init: { method?: string; body?: unknown } = {},
	fallback = "Something went wrong. Please try again.",
): Promise<T> {
	const response = await authFetch(url, {
		method: init.method ?? "GET",
		...(init.body === undefined
			? {}
			: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
	});
	if (!response.ok) throw new Error(await driveError(response, fallback));
	return (await response.json()) as T;
}

export function refreshDrive(): void {
	window.dispatchEvent(new Event(DRIVE_REFRESH_EVENT));
}

export function createFolder(name: string, parentId: string | null) {
	return driveRequest<{ item: DriveItemDto }>("/api/drive/folders", { method: "POST", body: { name, parentId } });
}

export function renameItem(id: string, name: string) {
	return driveRequest<{ item: DriveItemDto }>(`/api/drive/items/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: { name },
	});
}

export type BulkAction = "trash" | "restore" | "delete" | "move";

export function bulkItems(ids: string[], action: BulkAction, parentId?: string | null) {
	return driveRequest<{ count: number }>("/api/drive/items/bulk", {
		method: "POST",
		body: { ids, action, ...(action === "move" ? { parentId: parentId ?? null } : {}) },
	});
}

export function saveAttachment(attachmentId: string, parentId: string | null) {
	return driveRequest<{ item: DriveItemDto }>(
		`/api/drive/attachments/${encodeURIComponent(attachmentId)}/save`,
		{ method: "POST", body: { parentId } },
		"Could not save to Drive",
	);
}
