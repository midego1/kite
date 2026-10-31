import { formatAttachmentSize, resolveInlineAttachmentUrls } from "@/app/(dashboard)/inbox/[messageId]/utils";
import type { EmailHtmlSanitizer } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-types";
import { parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import type { PrintDocumentInput, PrintHeaderInput, PrintHeaderRow, PrintMessage, PrintSource } from "./print-types";

const FALLBACK_FILE_NAME = "Email";
const MAX_FILE_NAME_LENGTH = 100;
// Names Windows keeps for devices, with or without an extension.
const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A file name for a message saved as PDF: its subject with characters file systems refuse (`/ \ : * ? " < > |`
 * and control characters) replaced by spaces, runs of spaces collapsed, leading and trailing dots and spaces
 * removed, and at most 100 characters before `.pdf`. An empty subject, or one that is only punctuation, is "Email".
 */
export function pdfFileName(subject: string | null | undefined): string {
	const cleaned = (subject ?? "")
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	const characters = [...cleaned];
	const shortened =
		characters.length > MAX_FILE_NAME_LENGTH ? characters.slice(0, MAX_FILE_NAME_LENGTH).join("") : cleaned;
	const base = shortened.replace(/[.\s]+$/g, "") || FALLBACK_FILE_NAME;
	return `${RESERVED_FILE_NAMES.test(base) ? `${base} email` : base}.pdf`;
}

/** An address header for print: every entry as `Name <address>`, or the bare address when it has no name.
 * @public Exercised by the unit tests.
 */
export function formatPrintAddresses(value: string | null | undefined): string {
	return splitEmailAddressList(value)
		.map((entry) => {
			const { name, address } = parseEmailAddressParts(entry);
			return name && name !== address ? `${name} <${address}>` : address;
		})
		.filter(Boolean)
		.join(", ");
}

/** The header lines printed above a message, in the order a mail client shows them; empty ones are left out.
 * @public Exercised by the unit tests.
 */
export function printHeaderRows(input: PrintHeaderInput): PrintHeaderRow[] {
	const rows: PrintHeaderRow[] = [
		{ label: "From", value: formatPrintAddresses(input.from) },
		{ label: "To", value: formatPrintAddresses(input.to) },
		{ label: "Cc", value: formatPrintAddresses(input.cc) },
		{ label: "Bcc", value: formatPrintAddresses(input.bcc) },
		{ label: "Date", value: input.date },
	];
	return rows.filter((row) => row.value.trim() !== "");
}

/**
 * One message as Print shows it: the whole body through the reader's sanitizer with the quoted history left
 * unfolded (nothing is folded into a toggle), remote images blocked unless the reader shows them, and the names and
 * sizes of its attachments (inline images are part of the body).
 */
export function toPrintMessage(
	source: PrintSource,
	{ sanitize, formatDate }: { sanitize: EmailHtmlSanitizer; formatDate: (value: string) => string },
): PrintMessage {
	const attachments = source.attachments ?? [];
	const html = source.htmlBody
		? sanitize(resolveInlineAttachmentUrls(source.htmlBody, source.id, attachments), {
				blockRemoteImages: source.blockRemoteImages,
				proxyRemoteImagesFor: source.id,
				linkify: true,
			})
		: null;
	return {
		id: source.id,
		subject: source.subject?.trim() ?? "",
		headers: printHeaderRows({
			from: source.fromAddr,
			to: source.toAddr,
			cc: source.ccAddr,
			bcc: source.bccAddr,
			date: formatDate(source.createdAt),
		}),
		attachments: attachments
			.filter((attachment) => attachment.disposition === "attachment")
			.map((attachment) => ({ filename: attachment.filename, size: formatAttachmentSize(attachment.size) })),
		// The reader loads images lazily; the hidden print frame must have them all before the dialog opens.
		html: html?.trim() ? html.replace(/(<img\b[^>]*?)\sloading="lazy"/g, "$1") : null,
		text: source.textBody ?? source.snippet ?? "",
	};
}

/** The messages of a conversation once each, oldest first, as they are printed. */
export function orderForPrint<T extends { id: string; createdAt: string }>(messages: T[]): T[] {
	const byId = new Map<string, T>();
	for (const message of messages) byId.set(message.id, message);
	return [...byId.values()].sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Light colours whatever the app's theme: the print document has no theme, only the mail's own colours.
const PRINT_STYLES = [
	"@page{margin:16mm 14mm}",
	"html{color-scheme:light;background:#fff}",
	'body{margin:0;color:#171717;background:#fff;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
	".print-title{margin:0 0 4px;font-size:20px;line-height:1.3;font-weight:700}",
	".print-count{margin:0;color:#525252;font-size:13px}",
	".print-message{padding-top:16px}",
	".print-message+.print-message{margin-top:24px;border-top:1px solid #d4d4d4}",
	".print-message-subject{margin:0 0 8px;font-size:15px;font-weight:600}",
	".print-headers{border-collapse:collapse;margin:0 0 12px;font-size:13px;break-inside:avoid;break-after:avoid}",
	".print-headers th{padding:1px 12px 1px 0;color:#525252;font-weight:600;text-align:left;vertical-align:top;white-space:nowrap}",
	".print-headers td{padding:1px 0}",
	".print-attachments{margin:0 0 12px;padding:8px 12px;border:1px solid #e5e5e5;border-radius:6px;font-size:13px;break-inside:avoid}",
	".print-attachments p{margin:0 0 2px;color:#525252;font-weight:600}",
	".print-attachments ul{margin:0;padding-left:18px}",
	".print-attachment-size{color:#525252}",
	".print-body{border-top:1px solid #e5e5e5;padding-top:12px}",
	".print-body img{max-width:100%;height:auto;break-inside:avoid}",
	".print-body table{max-width:100%}",
	".print-body tr{break-inside:avoid}",
	".print-body ul{list-style:disc;padding-left:1.5rem;margin:.25rem 0}",
	".print-body ol{list-style:decimal;padding-left:1.5rem;margin:.25rem 0}",
	".print-body blockquote{border-left:2px solid #d4d4d4;margin:.25rem 0;padding-left:.75rem;color:#525252}",
	".print-body p{margin:0 0 .5rem}",
	".print-body a{color:#2563eb}",
	".print-text{margin:0;white-space:pre-wrap;font:inherit}",
	"h1,h2,h3{break-after:avoid}",
].join("");

// Defence in depth on top of the sanitizer and the frame's sandbox: no scripts, frames or fonts, images only from
// Kite itself (inline attachments and the remote-image proxy) or data URLs, so a blocked image cannot load here.
const PRINT_CSP = "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'";

function renderHeaders(rows: PrintHeaderRow[]): string {
	if (!rows.length) return "";
	const body = rows
		.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
		.join("");
	return `<table class="print-headers"><tbody>${body}</tbody></table>`;
}

function renderAttachments(message: PrintMessage): string {
	if (!message.attachments.length) return "";
	const items = message.attachments
		.map(
			(attachment) =>
				`<li>${escapeHtml(attachment.filename)} <span class="print-attachment-size">(${escapeHtml(attachment.size)})</span></li>`,
		)
		.join("");
	return `<div class="print-attachments"><p>Attachments (${message.attachments.length})</p><ul>${items}</ul></div>`;
}

function renderMessage(message: PrintMessage, title: string): string {
	// In a conversation a message whose subject differs from the first one's (a renamed thread) names it.
	const subject =
		message.subject && message.subject !== title
			? `<h2 class="print-message-subject">${escapeHtml(message.subject)}</h2>`
			: "";
	// `html` comes from the reader's sanitizer only; everything else is text and escaped here.
	const body = message.html ?? `<pre class="print-text">${escapeHtml(message.text)}</pre>`;
	return `<article class="print-message">${subject}${renderHeaders(message.headers)}${renderAttachments(message)}<div class="print-body">${body}</div></article>`;
}

/**
 * The document printed for one message or a conversation: the subject, then each message's headers, attachment
 * names and body. Message bodies must already be sanitized (`html`) or plain text (`text`); headers, names and the
 * title are escaped here.
 */
export function buildPrintDocument({ title, messages }: PrintDocumentInput): string {
	const heading = title.trim() || "(no subject)";
	const count =
		messages.length > 1 ? `<p class="print-count">${messages.length} messages in this conversation</p>` : "";
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
		'<meta name="referrer" content="no-referrer">',
		`<title>${escapeHtml(heading)}</title>`,
		`<style>${PRINT_STYLES}</style>`,
		"</head><body>",
		`<h1 class="print-title">${escapeHtml(heading)}</h1>`,
		count,
		messages.map((message) => renderMessage(message, heading)).join(""),
		"</body></html>",
	].join("");
}
