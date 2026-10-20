import {
	File as FileIcon,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Folder,
	Presentation,
	type LucideIcon,
} from "lucide-react";
import type { DriveItemDto } from "@/lib/drive/types";
import { driveIconKind, type DriveIconKind } from "./drive-utils";

// Palette classes, not hex, so the dark theme and the Classic style remap them.
const ICONS: Record<DriveIconKind, { Icon: LucideIcon; className: string }> = {
	folder: { Icon: Folder, className: "text-amber-500" },
	image: { Icon: FileImage, className: "text-rose-500" },
	video: { Icon: FileVideo, className: "text-purple-500" },
	audio: { Icon: FileAudio, className: "text-orange-500" },
	pdf: { Icon: FileText, className: "text-red-600" },
	spreadsheet: { Icon: FileSpreadsheet, className: "text-green-600" },
	slides: { Icon: Presentation, className: "text-orange-600" },
	archive: { Icon: FileArchive, className: "text-yellow-700" },
	code: { Icon: FileCode, className: "text-teal-500" },
	document: { Icon: FileText, className: "text-blue-500" },
	file: { Icon: FileIcon, className: "text-neutral-500" },
};

export function driveIconFor(item: Pick<DriveItemDto, "kind" | "contentType" | "name">) {
	return ICONS[driveIconKind(item)];
}
