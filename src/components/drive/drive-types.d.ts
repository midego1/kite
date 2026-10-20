import type { DriveCrumb, DriveItemDto, DriveRole, DriveUsage } from "@/lib/drive/types";

/** The listing pages: the four API views plus All attachments, which has its own endpoint. */
export type DriveListingView = "my" | "recent" | "shared" | "attachments" | "trash";

export type DriveSortKey = "name" | "owner" | "updatedAt" | "size";

export type DrivePreviewKind = "image" | "video" | "audio" | "pdf" | "text";

/** What `GET /api/drive/items` (or `/api/drive/attachments`) answers for one page. */
export type DriveListing = {
	items: DriveItemDto[];
	path: DriveCrumb[];
	role: DriveRole;
	folder?: { id: string; name: string; ownerId: string };
	nextCursor: string | null;
	usage?: DriveUsage;
	migrationPending?: boolean;
};

export type DriveUploadStatus = "queued" | "uploading" | "done" | "failed" | "cancelled";

export type DriveUploadEntry = {
	id: string;
	name: string;
	percent: number;
	resumed: boolean;
	status: DriveUploadStatus;
	error?: string;
};

/** A dialog the listing has open, with the rows it acts on. */
export type DriveDialog =
	| { kind: "new-folder" }
	| { kind: "rename"; item: DriveItemDto }
	| { kind: "move"; items: DriveItemDto[] }
	| { kind: "share"; item: DriveItemDto }
	| { kind: "preview"; item: DriveItemDto }
	| { kind: "save"; item: DriveItemDto };
