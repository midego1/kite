import type { DriveView } from "./types";

export const DRIVE_PAGE_SIZE = 100;
const VIEWS: DriveView[] = ["my", "shared", "recent", "trash"];

export function parseDriveView(value: string | null): DriveView | null {
	if (value === null || value === "") return "my";
	return (VIEWS as string[]).includes(value) ? (value as DriveView) : null;
}

/** A page boundary on `(sortedAt desc, id desc)`, as an opaque string the client sends back. */
export type DriveCursor = { at: number; id: string };

export function encodeDriveCursor(cursor: DriveCursor): string {
	return btoa(`${cursor.at}:${cursor.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeDriveCursor(value: string | null): DriveCursor | null {
	if (!value) return null;
	try {
		const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
		const match = /^(\d{1,15}):([A-Za-z0-9_-]{1,80})$/.exec(decoded);
		return match ? { at: Number(match[1]), id: match[2] } : null;
	} catch {
		return null;
	}
}

/** The cursor for the next page when this one is full, else null. */
export function nextDriveCursor<T>(rows: T[], pageSize: number, of: (row: T) => DriveCursor): string | null {
	return rows.length < pageSize ? null : encodeDriveCursor(of(rows[rows.length - 1]));
}

/** A `LIKE` pattern matching `query` anywhere, with `%`, `_` and the escape character taken literally. */
export function containsPattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}
