/**
 * A standalone document for the preview iframe. The app's own stylesheet does
 * not reach it, so the message renders roughly as a mail client shows it.
 */
export function buildPreviewDocument(html: string): string {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<base target="_blank">',
		"<style>",
		"html{color-scheme:light}",
		"body{margin:0;padding:16px;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:anywhere}",
		"img{max-width:100%;height:auto}",
		"blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}",
		"</style></head><body>",
		html,
		"</body></html>",
	].join("");
}

export function formatPreviewAttachments(names: string[]): string | null {
	return names.length > 0 ? names.join(", ") : null;
}
