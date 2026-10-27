import { FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import type { FolderColor } from "@/lib/folders/types";

/** Folder colours by the names the folder picker shows, lower-cased for the tool schema. */
export const FOLDER_COLOR_NAMES = FOLDER_COLOR_OPTIONS.map((option) => option.label.toLowerCase()) as [
	string,
	...string[],
];

/** The stored value of a colour name, or null for no or an unknown name. */
export function folderColorValue(name: string | null | undefined): FolderColor | null {
	if (!name) return null;
	const wanted = name.trim().toLowerCase();
	return FOLDER_COLOR_OPTIONS.find((option) => option.label.toLowerCase() === wanted)?.value ?? null;
}
