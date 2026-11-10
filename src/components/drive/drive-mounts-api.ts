import { authFetch } from "@/lib/auth/client";
import type { DriveMountDto, DriveMountItemDto } from "@/lib/drive/types";
import { driveError, driveRequest } from "./drive-api";

/** Sent after a folder is linked, edited or unlinked, so the Drive menu and the pickers reload the list. */
export const DRIVE_MOUNTS_EVENT = "kite:drive-mounts";

export type MountListing = {
	mount: DriveMountDto | null;
	path: string;
	items: DriveMountItemDto[];
	migrationPending?: boolean;
};
export type MountForm = { label: string; url: string; username: string; password: string };

const base = (id: string) => `/api/drive/mounts/${encodeURIComponent(id)}`;

export function refreshMounts(): void {
	window.dispatchEvent(new Event(DRIVE_MOUNTS_EVENT));
}

export function mountHref(id: string, path = "/"): string {
	const href = `/drive/m/${encodeURIComponent(id)}`;
	return path === "/" ? href : `${href}?${new URLSearchParams({ path })}`;
}

export function listMounts() {
	return driveRequest<{ mounts: DriveMountDto[]; encryptionReady: boolean; migrationPending?: boolean }>(
		"/api/drive/mounts",
		{},
		"Could not load your linked folders",
	);
}

export function linkMount(form: MountForm) {
	return driveRequest<{ mount: DriveMountDto }>(
		"/api/drive/mounts",
		{ method: "POST", body: form },
		"Could not link the folder",
	);
}

/** An empty password keeps the saved one. */
export function updateMount(id: string, form: Partial<MountForm>) {
	return driveRequest<{ mount: DriveMountDto }>(base(id), { method: "PATCH", body: form }, "Could not save the folder");
}

export function unlinkMount(id: string) {
	return driveRequest<{ ok: true }>(base(id), { method: "DELETE" }, "Could not unlink the folder");
}

export function listMountItems(id: string, path: string) {
	return driveRequest<MountListing>(
		`${base(id)}/items?${new URLSearchParams({ path })}`,
		{},
		"Could not open this folder",
	);
}

export function createMountFolder(id: string, parent: string, name: string) {
	return driveRequest<{ item: DriveMountItemDto }>(`${base(id)}/folders`, { method: "POST", body: { parent, name } });
}

export function moveMountItem(id: string, path: string, change: { name?: string; parent?: string }) {
	return driveRequest<{ item: DriveMountItemDto }>(`${base(id)}/items`, { method: "PATCH", body: { path, ...change } });
}

export function deleteMountItem(id: string, path: string) {
	return driveRequest<{ ok: true }>(`${base(id)}/items?${new URLSearchParams({ path })}`, { method: "DELETE" });
}

export function mountFileUrl(id: string, path: string, download = false): string {
	const query = new URLSearchParams({ path });
	if (download) query.set("disposition", "attachment");
	return `${base(id)}/content?${query}`;
}

/** Streams one file to the server as the raw request body; the browser sends its length. */
export async function uploadMountFile(id: string, parent: string, file: File): Promise<void> {
	const response = await authFetch(`${base(id)}/content?${new URLSearchParams({ parent, name: file.name })}`, {
		method: "PUT",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!response.ok) throw new Error(await driveError(response, `Could not upload ${file.name}`));
}

/** Save to Drive into a linked folder; `acknowledge` as for Drive's own copy. */
export function saveAttachmentToMount(attachmentId: string, mountId: string, path: string, acknowledge = false) {
	return driveRequest<{ item: DriveMountItemDto }>(
		`/api/drive/attachments/${encodeURIComponent(attachmentId)}/save`,
		{ method: "POST", body: acknowledge ? { mountId, path, acknowledge } : { mountId, path } },
		"Could not save to the linked folder",
	);
}
