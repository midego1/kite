export const DRIVE_CATEGORIES = ["photos", "videos", "documents", "others"] as const;
export type DriveCategory = (typeof DRIVE_CATEGORIES)[number];

export function isDriveCategory(value: string | null): value is DriveCategory {
	return !!value && (DRIVE_CATEGORIES as readonly string[]).includes(value);
}

/** Parses `?types=photos,videos` into known categories. */
export function parseDriveCategories(value: string | null): DriveCategory[] {
	return [...new Set((value ?? "").split(",").filter(isDriveCategory))];
}

export const DRIVE_CATEGORY_LABELS: Record<DriveCategory, string> = {
	photos: "Photos",
	videos: "Videos",
	documents: "Documents",
	others: "Others",
};
