/**
 * Attachment risk without an antivirus engine: file types that run code or carry macros, names that disguise their
 * type, and the names inside ZIP archives (bounded). It does not find malware in an ordinary-looking file; it stops a
 * one-click download of things that are dangerous by design. Pure and client-safe: the reader labels attachment chips
 * with it, and the spam analyzer (`spam/analyzers/attachments.ts`) reads the same extension lists so they cannot drift.
 * Adapted from upstream Mailflare (hieunc229/mailflare#218, AGPL-3.0).
 */
import type { AttachmentRisk, AttachmentRiskLevel } from "./attachment-risk-types";

/** Run code when opened, including shortcuts, installers, scripts and add-ins (`.xll` is a DLL for Excel). */
const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
	"apk",
	"app",
	"appimage",
	"application",
	"appx",
	"bat",
	"chm",
	"cmd",
	"com",
	"command",
	"cpl",
	"deb",
	"desktop",
	"diagcab",
	"dll",
	"dmg",
	"exe",
	"gadget",
	"hlp",
	"hta",
	"inf",
	"jar",
	"jnlp",
	"js",
	"jse",
	"library-ms",
	"lnk",
	"msc",
	"msi",
	"msix",
	"msp",
	"pif",
	"pkg",
	"ps1",
	"ps1xml",
	"psm1",
	"py",
	"reg",
	"rpm",
	"scf",
	"scr",
	"settingcontent-ms",
	"sh",
	"url",
	"vb",
	"vbe",
	"vbs",
	"webloc",
	"ws",
	"wsc",
	"wsf",
	"wsh",
	"xll",
]);
/**
 * Office formats that carry macros or pull in live data (`.iqy`, `.slk`). The legacy binary formats (`.doc`, `.xls`,
 * `.ppt`) can carry macros too but are not flagged: their name cannot tell a macro-free file apart, they are still
 * common, and Office opens downloaded files with macros blocked.
 */
const MACRO_EXTENSIONS: ReadonlySet<string> = new Set([
	"docm",
	"dotm",
	"iqy",
	"potm",
	"ppam",
	"pptm",
	"sldm",
	"slk",
	"xlam",
	"xlsb",
	"xlsm",
	"xltm",
]);
/** Mount like a disk and hide the files inside from mail filters. */
const DISK_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["img", "iso", "vhd", "vhdx"]);
/** Open in a browser, where they can show a fake login page. */
const WEB_PAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	"htm",
	"html",
	"mht",
	"mhtml",
	"shtml",
	"svg",
	"svgz",
	"xhtml",
]);
const OTHER_CONTAINER_EXTENSIONS: ReadonlySet<string> = new Set(["one", "onepkg"]);
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
	"7z",
	"ace",
	"bz2",
	"cab",
	"gz",
	"rar",
	"tar",
	"tgz",
	"xz",
	"zip",
]);
/** What a disguised name pretends to be: `invoice.pdf.exe`. */
const DOCUMENT_LOOKING_EXTENSIONS: ReadonlySet<string> = new Set([
	"csv",
	"doc",
	"docx",
	"gif",
	"jpeg",
	"jpg",
	"mp3",
	"mp4",
	"pdf",
	"png",
	"ppt",
	"pptx",
	"rtf",
	"txt",
	"xls",
	"xlsx",
]);
const PROGRAM_TYPES: ReadonlySet<string> = new Set([
	"application/java-archive",
	"application/vnd.android.package-archive",
	"application/vnd.microsoft.portable-executable",
	"application/x-dosexec",
	"application/x-elf",
	"application/x-executable",
	"application/x-mach-binary",
	"application/x-msdos-program",
	"application/x-msdownload",
	"application/x-msi",
	"application/x-sh",
]);
/**
 * C0 and C1 controls and the bidi marks and overrides that reorder text: U+202E makes `invoice<U+202E>fdp.exe` read
 * as `invoiceexe.pdf`.
 */
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function hasHiddenCharacters(filename: string): boolean {
	return filename.search(HIDDEN_CHARACTERS) >= 0;
}

/** The name without control characters and bidi marks, as stored and as sent in headers. */
export function stripHiddenCharacters(filename: string): string {
	return filename.replace(HIDDEN_CHARACTERS, "");
}

const MAX_ZIP_ENTRIES = 1000;
/** Upper bound for the central directory read; anything larger is reported unchecked. */
const MAX_ZIP_DIRECTORY_BYTES = 1024 * 1024;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 64 KiB. */
export const ZIP_TAIL_BYTES = 22 + 65_535;
const MAX_REASONS = 5;
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

const RANK: Record<AttachmentRiskLevel, number> = { ok: 0, warning: 1, danger: 2 };

/**
 * Lower-cased extensions after the first dot. Trailing dots and spaces are dropped, as Windows drops them, and the name
 * ends at the first `:`, because NTFS stores `setup.exe:notes.txt` as `setup.exe` with an alternate data stream.
 */
function fileExtensions(filename: string): string[] {
	const base = (filename.split(/[/\\]/).pop() ?? "").split(":", 1)[0];
	return (
		base
			.toLowerCase()
			// From the start of a run only, so a long run of dots inside a name is not rescanned from each of them.
			.replace(/(?<![.\s])[.\s]+$/, "")
			.split(".")
			.slice(1)
			.map((part) => part.trim())
	);
}

function lastExtension(filename: string): string {
	return fileExtensions(filename).at(-1) ?? "";
}

/** Programs and disk images: the spam analyzer's `risky_attachment`. */
export function isExecutableFilename(filename: string): boolean {
	const last = lastExtension(filename);
	return PROGRAM_EXTENSIONS.has(last) || DISK_IMAGE_EXTENSIONS.has(last);
}

export function isWebPageFilename(filename: string): boolean {
	return WEB_PAGE_EXTENSIONS.has(lastExtension(filename));
}

/** A document-looking extension followed by another one: `invoice.pdf.html`. */
export function hasDecoyExtension(filename: string): boolean {
	const extensions = fileExtensions(filename);
	return extensions.length >= 2 && DOCUMENT_LOOKING_EXTENSIONS.has(extensions[extensions.length - 2]);
}

export function mergeRisks(...risks: AttachmentRisk[]): AttachmentRisk {
	let level: AttachmentRiskLevel = "ok";
	const reasons: string[] = [];
	for (const risk of risks) {
		if (RANK[risk.level] > RANK[level]) level = risk.level;
		for (const reason of risk.reasons) if (!reasons.includes(reason)) reasons.push(reason);
	}
	return { level, reasons: reasons.slice(0, MAX_REASONS) };
}

/** Risk judged from the name and declared type alone. */
export function assessAttachmentRisk(attachment: { filename: string; type?: string | null }): AttachmentRisk {
	const found: AttachmentRisk[] = [];
	const raise = (level: AttachmentRiskLevel, reason: string) => found.push({ level, reasons: [reason] });
	const last = lastExtension(attachment.filename);
	if (hasHiddenCharacters(attachment.filename))
		raise("danger", "The file name contains hidden characters that can disguise its real type.");
	if (PROGRAM_EXTENSIONS.has(last)) raise("danger", `.${last} files run programs when opened.`);
	else if (MACRO_EXTENSIONS.has(last))
		raise("danger", `.${last} files can run macros or load content from the internet.`);
	else if (DISK_IMAGE_EXTENSIONS.has(last)) raise("warning", `.${last} files open like a disk and can hide programs.`);
	else if (WEB_PAGE_EXTENSIONS.has(last))
		raise("warning", `.${last} files open in a browser and can show a fake login page.`);
	else if (OTHER_CONTAINER_EXTENSIONS.has(last)) raise("warning", `.${last} files can hide other files.`);
	else if (ARCHIVE_EXTENSIONS.has(last))
		raise("warning", "Archives can hide other files; open them only if you expected this one.");
	const disguising =
		PROGRAM_EXTENSIONS.has(last) ||
		MACRO_EXTENSIONS.has(last) ||
		DISK_IMAGE_EXTENSIONS.has(last) ||
		WEB_PAGE_EXTENSIONS.has(last);
	if (disguising && hasDecoyExtension(attachment.filename))
		raise("danger", "The name has two extensions to look like a harmless document.");
	const type = (attachment.type ?? "").split(";", 1)[0].trim().toLowerCase();
	if (PROGRAM_TYPES.has(type)) raise("danger", "The file is declared as a program.");
	return mergeRisks(...found);
}

/** Whether the server should look inside the file: a ZIP by name or declared type. */
export function isZipAttachment(attachment: { filename: string; type?: string | null }): boolean {
	const type = (attachment.type ?? "").split(";", 1)[0].trim().toLowerCase();
	return (
		lastExtension(attachment.filename) === "zip" ||
		type === "application/zip" ||
		type === "application/x-zip-compressed"
	);
}

function endOfDirectory(tail: Uint8Array): number {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
		if (view.getUint32(index, true) === END_OF_DIRECTORY) return index;
	}
	return -1;
}

/** Where a ZIP's central directory sits, read from the end of the file; null when the tail has no end record. */
export function locateZipDirectory(tail: Uint8Array): { entries: number; offset: number; size: number } | null {
	const index = endOfDirectory(tail);
	if (index < 0) return null;
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	return {
		entries: view.getUint16(index + 10, true),
		size: view.getUint32(index + 12, true),
		offset: view.getUint32(index + 16, true),
	};
}

/** Why a located directory is not read at all, or null when it may be. */
export function zipDirectoryRefusal(located: { entries: number; offset: number; size: number }): AttachmentRisk | null {
	if (located.entries === 0xffff || located.size === 0xffffffff || located.offset === 0xffffffff)
		return { level: "warning", reasons: ["This archive uses a format that cannot be checked here."] };
	if (located.entries > MAX_ZIP_ENTRIES || located.size > MAX_ZIP_DIRECTORY_BYTES)
		return { level: "warning", reasons: ["This archive holds too many files to check them all."] };
	return null;
}

/**
 * Risk from the names in a ZIP's central directory, without extracting anything. `directory` is null when it could
 * not be read, which is flagged rather than trusted. Password-protected entries are flagged too.
 */
export function inspectZipDirectory(
	located: { entries: number; offset: number; size: number },
	directory: Uint8Array | null,
): AttachmentRisk {
	const refusal = zipDirectoryRefusal(located);
	if (refusal) return refusal;
	if (!directory) return { level: "warning", reasons: ["This archive could not be checked."] };
	const listing = readZipNames(directory);
	const found: AttachmentRisk[] = listing.names.map((name) => {
		const inner = assessAttachmentRisk({ filename: name.split("/").pop() || name });
		return { level: inner.level, reasons: inner.reasons.map((reason) => `Inside the archive, ${name}: ${reason}`) };
	});
	if (listing.encrypted)
		found.push({
			level: "warning",
			reasons: ["This archive is password protected, so its contents could not be checked."],
		});
	if (listing.overflow)
		found.push({ level: "warning", reasons: ["This archive holds too many files to check them all."] });
	else if (!listing.complete) found.push({ level: "warning", reasons: ["This archive could not be fully checked."] });
	return mergeRisks(...found);
}

/**
 * The entry names in a central directory, walked by its bytes rather than the end record's entry count, which a
 * crafted archive can understate to hide entries. `complete` is false when the walk stopped before the end.
 */
function readZipNames(directory: Uint8Array): {
	names: string[];
	encrypted: boolean;
	complete: boolean;
	overflow: boolean;
} {
	const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const names: string[] = [];
	let encrypted = false;
	let position = 0;
	while (position + 46 <= directory.byteLength && view.getUint32(position, true) === DIRECTORY_ENTRY) {
		if (names.length >= MAX_ZIP_ENTRIES) return { names, encrypted, complete: false, overflow: true };
		const nameLength = view.getUint16(position + 28, true);
		const next = position + 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
		if (next > directory.byteLength) break;
		if (view.getUint16(position + 8, true) & 1) encrypted = true;
		names.push(decoder.decode(directory.subarray(position + 46, position + 46 + nameLength)));
		position = next;
	}
	return { names, encrypted, complete: position === directory.byteLength, overflow: false };
}

/**
 * Whether a download should go through the warning first: flagged by name or type, or a ZIP whose contents only the
 * server can read. Client code sends these to the viewer instead of linking the file directly.
 */
export function needsRiskReview(attachment: { filename: string; type?: string | null }): boolean {
	return assessAttachmentRisk(attachment).level !== "ok" || isZipAttachment(attachment);
}
