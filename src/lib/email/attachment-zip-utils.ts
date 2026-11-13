import { stripHiddenCharacters } from "./attachment-risk";
import { sanitizeFilename } from "./attachment-name-utils";
import { truncateUtf8 } from "./inbound-limits";

/** Characters Windows refuses in a file name; extraction there would fail or rename the file. */
const WINDOWS_RESERVED = /[<>:"|?*]/g;
/** Device names Windows reserves whatever the extension (`CON.txt`, `com1.pdf`). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MAX_ARCHIVE_NAME_BYTES = 80;

/**
 * An attachment's name inside the archive: the stored-name rules of `sanitizeFilename` (no slashes or backslashes, so
 * every entry lands in the archive's top folder and none can climb out with `..`, no control or bidi characters, at
 * most 180 UTF-8 bytes) plus the characters, trailing dots and device names Windows cannot extract. NFC, so a name
 * reads the same on every file system.
 * @public Exercised by the unit tests; `uniqueZipEntryNames` is the way in.
 */
export function zipEntryName(filename: string): string {
	const name = sanitizeFilename(filename.normalize("NFC"))
		.replace(WINDOWS_RESERVED, "_")
		.replace(/[. ]+$/, "");
	if (!name) return "attachment";
	return WINDOWS_DEVICE.test(name) ? `_${name}` : name;
}

/** `name` with ` (copy)` before its extension: `report.pdf` → `report (2).pdf`. */
function numbered(name: string, copy: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} (${copy})${name.slice(dot)}` : `${name} (${copy})`;
}

/**
 * Safe names for every attachment, in order. A name already taken gets ` (2)`, ` (3)`, … before its extension, and
 * names that differ only in case count as taken, because macOS and Windows would extract them over each other.
 */
export function uniqueZipEntryNames(filenames: readonly string[]): string[] {
	const taken = new Set<string>();
	return filenames.map((filename) => {
		const name = zipEntryName(filename);
		for (let copy = 1; ; copy += 1) {
			const candidate = copy === 1 ? name : numbered(name, copy);
			const key = candidate.toLowerCase();
			if (!taken.has(key)) {
				taken.add(key);
				return candidate;
			}
		}
	});
}

/** The download name of a message's archive: its subject made safe as a file name, or `attachments.zip`. */
export function attachmentsArchiveName(subject: string | null | undefined): string {
	const cleaned = stripHiddenCharacters((subject ?? "").normalize("NFC"))
		.replace(/[/\\]/g, " ")
		.replace(WINDOWS_RESERVED, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.zip$/i, "");
	const short = truncateUtf8(cleaned, MAX_ARCHIVE_NAME_BYTES).replace(/[. ]+$/, "");
	if (!short || WINDOWS_DEVICE.test(short)) return "attachments.zip";
	return `${short}.zip`;
}
