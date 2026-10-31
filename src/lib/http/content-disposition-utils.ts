import { truncateFilename } from "@/lib/email/attachment-name-utils";
import { stripHiddenCharacters } from "@/lib/email/attachment-risk";

/** Rows stored before names were capped can hold long names; this keeps `filename*` around 1 KB at most. */
const MAX_HEADER_FILENAME_BYTES = 180;

/**
 * A Content-Disposition value with an ASCII `filename` for old clients and the exact name as an RFC 5987
 * `filename*`, which browsers prefer. Quotes, backslashes, line breaks, other control characters and bidi
 * overrides never reach the header.
 */
export function getContentDisposition(filename: string, inline: boolean): string {
	const clean =
		truncateFilename(stripHiddenCharacters(filename.replace(/[\r\n]/g, " ")), MAX_HEADER_FILENAME_BYTES) ||
		"attachment";
	const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(clean).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
