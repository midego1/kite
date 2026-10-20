import type { DriveCrumb, DriveRole, DriveRow } from "./types";

export const DRIVE_MAX_NAME_LENGTH = 255;
/** Folder nesting limit; the recursive queries stop here, so a cycle in restored data cannot loop. */
export const DRIVE_MAX_DEPTH = 64;

/**
 * A usable file or folder name, or null. Control characters and path separators become spaces, runs of
 * whitespace collapse, and `.` and `..` are refused, so a name can never act as a path.
 */
export function normalizeDriveName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value
		.replace(/[\u0000-\u001f\u007f/\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, DRIVE_MAX_NAME_LENGTH)
		.trim();
	return name && name !== "." && name !== ".." ? name : null;
}

export function canEditDrive(role: DriveRole | null): boolean {
	return role === "owner" || role === "edit";
}

/** Keys carry only the item id: renames and moves never touch storage, and no names end up in key listings. */
export function driveObjectKey(itemId: string): string {
	return `drive/${itemId}`;
}

/**
 * Where an item opens. A file opens by its own id rather than under its folder, because a person it is
 * shared with may not see the folder.
 */
export function driveItemHref(item: Pick<DriveRow, "id" | "kind">): string {
	return item.kind === "folder"
		? `/drive/f/${encodeURIComponent(item.id)}`
		: `/drive?file=${encodeURIComponent(item.id)}`;
}

export function toDriveCrumbs(chain: Pick<DriveRow, "id" | "name">[]): DriveCrumb[] {
	return chain.map((item) => ({ id: item.id, name: item.name }));
}

export function formatDriveSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
