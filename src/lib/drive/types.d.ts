import type { driveItems, driveLinks } from "@/db/schema/drive";
import type { SessionUser } from "@/lib/auth/types";

export type DriveRow = typeof driveItems.$inferSelect;
export type DriveLinkRow = typeof driveLinks.$inferSelect;
export type DriveRole = "owner" | "edit" | "view";
export type DriveShareRole = "view" | "edit";
export type DriveView = "my" | "shared" | "recent" | "trash";

/** The signed-in user a Drive route acts for. */
export type DriveUser = Pick<SessionUser, "id" | "email" | "name" | "role" | "isPrimaryAdmin">;

export type DriveItemDto = {
	id: string;
	kind: "file" | "folder";
	name: string;
	size: number;
	contentType: string;
	parentId: string | null;
	ownerId: string;
	ownerName: string;
	role: DriveRole;
	shared: boolean;
	trashedAt: string | null;
	updatedAt: string;
	/** Set for files that come from an email rather than from Drive. */
	source?: { messageId: string; mailboxId: string | null; subject: string; direction: string };
};

export type DriveCrumb = { id: string; name: string };

export type DriveShareDto = { id: string; userId: string; name: string; email: string; role: DriveShareRole };

export type DriveLinkDto = {
	id: string;
	itemId: string;
	/** Only when the token can be shown: just created, or sealed with APP_ENCRYPTION_KEY. */
	url: string | null;
	hasPassword: boolean;
	expiresAt: string;
	revokedAt: string | null;
	downloadCount: number;
	lastAccessedAt: string | null;
	createdAt: string;
	active: boolean;
};

/** `limit` null is unlimited. */
export type DriveUsage = { used: number; limit: number | null };

export type DriveSettingsValues = {
	defaultQuotaBytes: number | null;
	linkMaxDays: number;
	trashRetentionDays: number;
};

/** A route's answer: the HTTP status and the JSON body. */
export type DriveAnswer = { status: number; body: Record<string, unknown> };
