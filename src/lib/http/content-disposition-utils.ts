/**
 * A Content-Disposition value with an ASCII `filename` for old clients and the exact name as an RFC 5987
 * `filename*`, which browsers prefer. Quotes, backslashes and line breaks never reach the header.
 */
export function getContentDisposition(filename: string, inline: boolean): string {
	const clean = filename.replace(/[\r\n]/g, " ");
	const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(clean).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
