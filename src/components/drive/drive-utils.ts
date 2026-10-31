import type { DriveItemDto } from "@/lib/drive/types";
import { needsRiskReview } from "@/lib/email/attachment-risk";
import type { DriveListingView, DrivePreviewKind, DriveSortKey } from "./drive-types";

/** Asks the open listing and the sidebar usage bar to reload, after a change made elsewhere on the page. */
export const DRIVE_REFRESH_EVENT = "kite:drive-refresh";
/** Detail: `DriveUsage`. Sent whenever a listing loads, so the sidebar can draw the usage bar. */
export const DRIVE_USAGE_EVENT = "kite:drive-usage";
/** Asks the listing to open its file picker or new-folder dialog, from the sidebar's New menu. */
export const DRIVE_COMMAND_EVENT = "kite:drive-command";

export type DriveCommand = "new-folder" | "upload-files" | "upload-folder";

const extensionOf = (name: string) => {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export type DriveIconKind =
	"folder" | "image" | "video" | "audio" | "pdf" | "spreadsheet" | "slides" | "archive" | "code" | "document" | "file";

const has = (list: string) => {
	const set = new Set(list.split(" "));
	return (extension: string) => set.has(extension);
};
const SPREADSHEET = has("xls xlsx ods csv numbers");
const SLIDES = has("ppt pptx odp key");
const ARCHIVE = has("zip rar 7z tar gz tgz");
const CODE = has("js ts tsx jsx json html css py rb go rs java c cpp h sh sql yml yaml xml");
const DOCUMENT = has("doc docx odt rtf txt md pages");

const ICON_RULES: ReadonlyArray<
	readonly [Exclude<DriveIconKind, "folder" | "file">, (type: string, ext: string) => boolean]
> = [
	["image", (type) => type.startsWith("image/")],
	["video", (type) => type.startsWith("video/")],
	["audio", (type) => type.startsWith("audio/")],
	["pdf", (type, ext) => type === "application/pdf" || ext === "pdf"],
	["spreadsheet", (type, ext) => /spreadsheet|ms-excel|csv/.test(type) || SPREADSHEET(ext)],
	["slides", (type, ext) => /presentation|ms-powerpoint/.test(type) || SLIDES(ext)],
	["archive", (type, ext) => /zip|compressed|x-tar|gzip|rar|7z/.test(type) || ARCHIVE(ext)],
	["code", (type, ext) => CODE(ext) || type === "application/json" || /javascript|xml/.test(type)],
	["document", (type, ext) => type.startsWith("text/") || /word|opendocument\.text/.test(type) || DOCUMENT(ext)],
];

/** Which icon a row gets: folders, then the first matching file rule, else a plain file. */
export function driveIconKind(item: Pick<DriveItemDto, "kind" | "contentType" | "name">): DriveIconKind {
	if (item.kind === "folder") return "folder";
	const extension = extensionOf(item.name);
	return ICON_RULES.find(([, test]) => test(item.contentType, extension))?.[0] ?? "file";
}

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function compareBy(key: DriveSortKey, a: DriveItemDto, b: DriveItemDto): number {
	if (key === "updatedAt") return a.updatedAt.localeCompare(b.updatedAt);
	if (key === "size") return a.size - b.size;
	if (key === "owner") return compareText(a.role === "owner" ? "" : a.ownerName, b.role === "owner" ? "" : b.ownerName);
	return 0;
}

/** Folders first, then by the chosen column, with the name breaking ties. */
export function sortDriveItems(items: readonly DriveItemDto[], key: DriveSortKey, ascending: boolean): DriveItemDto[] {
	const direction = ascending ? 1 : -1;
	return [...items].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		return (compareBy(key, a, b) || compareText(a.name, b.name)) * direction;
	});
}

/** The route serving a mail attachment in Drive, which also answers its risk check (`?risk=1`). */
export function attachmentContentUrl(attachmentId: string): string {
	return `/api/drive/attachments/${encodeURIComponent(attachmentId)}/content`;
}

/** The bytes of a row: a Drive file, or the mail attachment it stands for in All attachments. */
export function driveFileUrl(item: Pick<DriveItemDto, "id" | "source">, download = false): string {
	const base = item.source ? attachmentContentUrl(item.id) : `/api/drive/files/${encodeURIComponent(item.id)}/content`;
	return download ? `${base}?disposition=attachment` : base;
}

/**
 * A mail attachment row whose download goes through the risk warning (`needsRiskReview`); Drive's own files are
 * the user's uploads and never do.
 */
export function attachmentNeedsReview(item: Pick<DriveItemDto, "name" | "contentType" | "source">): boolean {
	return !!item.source && needsRiskReview({ filename: item.name, type: item.contentType });
}

export function publicContentUrl(token: string, itemId: string, download = false): string {
	const search = new URLSearchParams({ item: itemId });
	if (download) search.set("download", "1");
	return `/api/public/drive/${encodeURIComponent(token)}/content?${search}`;
}

/** The message an attachment came from, in the reader. */
export function emailHref(source: NonNullable<DriveItemDto["source"]>): string {
	return `/${source.direction === "outbound" ? "sent" : "inbox"}/${encodeURIComponent(source.messageId)}`;
}

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);

/**
 * How the preview shows a file. The server serves SVG, HTML and XML only as downloads, so they never preview.
 */
export function previewKind(contentType: string): DrivePreviewKind | null {
	if (contentType === "image/svg+xml") return null;
	if (contentType.startsWith("image/")) return "image";
	if (contentType.startsWith("video/")) return "video";
	if (contentType.startsWith("audio/")) return "audio";
	if (contentType === "application/pdf") return "pdf";
	return TEXT_TYPES.has(contentType) ? "text" : null;
}

export function folderHref(id: string): string {
	return `/drive/f/${encodeURIComponent(id)}`;
}

/** The page of a listing view; a folder of someone else's still has its own folder page. */
export function viewHref(view: DriveListingView): string {
	return view === "my" ? "/drive" : `/drive/${view}`;
}

export const DRIVE_VIEW_TITLES: Record<DriveListingView, string> = {
	my: "My Drive",
	recent: "Recent",
	shared: "Shared with me",
	attachments: "All attachments",
	trash: "Trash",
};

/** Whole percent of the limit used, capped at 100; 0 without a limit. */
export function usagePercent(used: number, limit: number | null): number {
	if (!limit || limit <= 0) return 0;
	return Math.min(100, Math.round((used / limit) * 100));
}

/** The folders an uploaded directory needs, parents before children, from each file's relative path. */
export function folderPathsOf(relativePaths: readonly string[]): string[] {
	const paths = new Set<string>();
	for (const path of relativePaths) {
		const parts = path.split("/").filter(Boolean);
		for (let depth = 1; depth < parts.length; depth += 1) paths.add(parts.slice(0, depth).join("/"));
	}
	return [...paths].sort((a, b) => a.split("/").length - b.split("/").length || compareText(a, b));
}

/** The folder path of a file inside an uploaded directory, or "" at its top. */
export function parentPathOf(relativePath: string): string {
	const parts = relativePath.split("/").filter(Boolean);
	return parts.slice(0, -1).join("/");
}

/** Identifies the same file picked again after a reload, so its upload resumes instead of starting over. */
export function uploadFingerprint(file: { name: string; size: number; lastModified: number }): string {
	return `${file.lastModified}:${file.size}`;
}

const GB = 1024 ** 3;

/** A quota typed in GB: empty is unlimited (null), anything else must be a positive number. */
export function parseQuotaGb(value: string): { bytes: number | null } | { error: string } {
	const trimmed = value.trim();
	if (!trimmed) return { bytes: null };
	const number = Number(trimmed);
	if (!Number.isFinite(number) || number <= 0) return { error: "Enter a positive number of GB, or leave it empty" };
	return { bytes: Math.round(number * GB) };
}

export function quotaToGb(bytes: number | null): string {
	if (bytes === null) return "";
	return String(Math.round((bytes / GB) * 100) / 100);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export function formatDriveDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export type DriveRowAction =
	"open" | "download" | "open-email" | "save" | "share" | "rename" | "move" | "trash" | "restore" | "delete";

const canEdit = (item: Pick<DriveItemDto, "role">) => item.role === "owner" || item.role === "edit";

/** The menu of one row, in order: what the viewer may do with it where it is listed. */
export function driveRowActions(item: Pick<DriveItemDto, "kind" | "role" | "trashedAt" | "source">): DriveRowAction[] {
	if (item.source) return ["open", "download", "open-email", "save"];
	if (item.trashedAt) return item.role === "owner" ? ["restore", "delete"] : [];
	const actions: DriveRowAction[] = ["open"];
	if (item.kind === "file") actions.push("download");
	if (canEdit(item)) actions.push("share", "rename", "move", "trash");
	return actions;
}

/** Whether a row can be selected for bulk actions: your own or editable items, and nothing from mail. */
export function isSelectable(item: Pick<DriveItemDto, "role" | "source">): boolean {
	return !item.source && canEdit(item);
}
