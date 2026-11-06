import { msg } from "@/lib/i18n/translator";
import {
	FileArchive,
	FileCode,
	FileSpreadsheet,
	FileText,
	FileType,
	FileVideoCamera,
	Image,
	Music,
	Presentation,
} from "lucide-react";
import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { AttachmentVisual } from "./message-attachment-card-types";
import { getAttachmentPreviewKind } from "./message-attachment-viewer-utils";

export function getAttachmentVisual(attachment: Pick<MessageAttachment, "filename" | "type">): AttachmentVisual {
	const type = attachment.type.toLowerCase();
	const filename = attachment.filename.toLowerCase();
	const previewKind = getAttachmentPreviewKind(attachment);

	if (previewKind === "image") {
		return {
			icon: Image,
			iconClassName: "bg-blue-50 text-blue-700",
			label: msg("file|Image"),
			thumbnail: "image",
		};
	}
	if (previewKind === "video") {
		return {
			icon: FileVideoCamera,
			iconClassName: "bg-rose-50 text-rose-700",
			label: msg("file|Video"),
			thumbnail: "video",
		};
	}
	if (previewKind === "audio") {
		return {
			icon: Music,
			iconClassName: "bg-orange-50 text-orange-700",
			label: msg("file|Audio"),
			thumbnail: null,
		};
	}
	if (previewKind === "pdf") {
		return {
			icon: FileText,
			iconClassName: "bg-red-50 text-red-700",
			label: msg("file|PDF"),
			thumbnail: null,
		};
	}
	if (
		type.includes("spreadsheet") ||
		type.includes("excel") ||
		type === "text/csv" ||
		/\.(csv|xls|xlsx|ods)$/.test(filename)
	) {
		return {
			icon: FileSpreadsheet,
			iconClassName: "bg-emerald-50 text-emerald-700",
			label: msg("file|Spreadsheet"),
			thumbnail: null,
		};
	}
	if (type.includes("presentation") || type.includes("powerpoint") || /\.(ppt|pptx|odp)$/.test(filename)) {
		return {
			icon: Presentation,
			iconClassName: "bg-amber-50 text-amber-700",
			label: msg("file|Presentation"),
			thumbnail: null,
		};
	}
	if (
		type.includes("zip") ||
		type.includes("compressed") ||
		type.includes("archive") ||
		/\.(zip|rar|7z|tar|gz|bz2)$/.test(filename)
	) {
		return {
			icon: FileArchive,
			iconClassName: "bg-violet-50 text-violet-700",
			label: msg("file|Archive"),
			thumbnail: null,
		};
	}
	if (
		type.includes("json") ||
		type.includes("xml") ||
		type.includes("javascript") ||
		type.includes("typescript") ||
		/\.(js|jsx|ts|tsx|json|xml|html|css|md|yml|yaml)$/.test(filename)
	) {
		return {
			icon: FileCode,
			iconClassName: "bg-cyan-50 text-cyan-700",
			label: msg("file|Code"),
			thumbnail: null,
		};
	}
	if (previewKind === "text" || type.includes("word") || /\.(doc|docx|odt|rtf|txt)$/.test(filename)) {
		return {
			icon: FileType,
			iconClassName: "bg-sky-50 text-sky-700",
			label: msg("file|Document"),
			thumbnail: null,
		};
	}

	return {
		icon: FileText,
		iconClassName: "bg-neutral-100 text-neutral-600",
		label: msg("file|File"),
		thumbnail: null,
	};
}
