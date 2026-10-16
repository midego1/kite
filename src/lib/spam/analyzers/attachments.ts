import type { AttachmentContent } from "@/lib/email/attachment-types";
import type { ParsedEmail } from "@/lib/email/parse";
import type { PreparedSpamContent, SpamSignal, WebPageAttachment } from "../types";

const EXECUTABLE_EXTENSION =
	/\.(exe|scr|com|pif|js|jse|vbs|vbe|wsf|wsh|bat|cmd|ps1|hta|msi|msix|appx|jar|lnk|cpl|reg|chm|iso|img|vhdx?)$/i;
const WEB_PAGE_EXTENSION = /\.(html?|shtml|xhtml|svgz?|mht|mhtml)$/i;
const WEB_PAGE_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)\b/i;
/** `invoice.pdf.html`: a document name with a web page or program extension after it. */
const DECOY_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png)\.[a-z0-9]{2,6}$/i;
const DOCUMENT_LURE =
	/\b(invoices?|factuur|facture|rechnung|payments?|remittance|receipts?|statements?|purchase orders?|quotes?|quotation|scan(ned)?|fax|voicemail|voice message|shared (file|document)|e-?sign(ature)?|docusign|contracts?|payroll|salary)\b/i;
const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const SCRIPT = /<script\b/i;
const SCRIPT_TRICK =
	/\b(atob|unescape|eval|fromCharCode|decodeURIComponent)\s*\(|\b(window|document|top|self)\.location\b|\blocation\.(href|replace|assign)\b/i;
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i;
const EXTERNAL_FORM = /<form\b[^>]*\baction\s*=\s*["']?https?:/i;
const MAX_PAGE_BYTES = 500_000;
const MAX_PAGES = 5;

function isExecutableAttachment(attachment: Pick<AttachmentContent, "filename">): boolean {
	return EXECUTABLE_EXTENSION.test(attachment.filename.trim());
}

/** An attached HTML or SVG file, which opens in a browser and can show a fake login page. Inline images are not. */
function isWebPageAttachment(
	attachment: Pick<AttachmentContent, "filename" | "type" | "disposition" | "contentId">,
): boolean {
	const filename = attachment.filename.trim();
	const type = attachment.type.trim().toLowerCase();
	if (attachment.disposition === "inline" && attachment.contentId && type.startsWith("image/")) return false;
	return WEB_PAGE_EXTENSION.test(filename) || WEB_PAGE_TYPE.test(type);
}

/** The text of the attached web pages (compressed SVG is skipped), so their links and code can be checked. */
export function readWebPageAttachments(attachments: readonly AttachmentContent[]): WebPageAttachment[] {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	return attachments
		.filter(isWebPageAttachment)
		.filter((attachment) => !/\.svgz$/i.test(attachment.filename.trim()))
		.slice(0, MAX_PAGES)
		.map((attachment) => ({
			filename: attachment.filename,
			text: decoder.decode(new Uint8Array(attachment.content ?? new ArrayBuffer(0)).subarray(0, MAX_PAGE_BYTES)),
		}));
}

function webPageSignals(message: ParsedEmail, prepared: PreparedSpamContent): SpamSignal[] {
	const pages = message.attachments.filter(isWebPageAttachment);
	if (!pages.length) return [];
	const decoy = pages.some((attachment) => DECOY_EXTENSION.test(attachment.filename.trim()));
	const lure = decoy || DOCUMENT_LURE.test(prepared.visibleText);
	const signals: SpamSignal[] = [
		{
			id: "html_attachment",
			score: lure ? 25 : 15,
			reason: lure
				? "An invoice or document arrives as an attached web page, a common way to show a fake login page"
				: "Message has an attached web page (HTML or SVG), a common way to show a fake login page",
			metadata: { count: pages.length, lure, decoy },
		},
	];
	const texts = prepared.webPageAttachments.map((page) => page.text);
	if (texts.some((text) => PASSWORD_FIELD.test(text) || EXTERNAL_FORM.test(text)))
		signals.push({
			id: "attachment_login_form",
			score: 30,
			reason: "An attached web page asks for a password or sends a form to a website",
		});
	if (texts.some((text) => (SCRIPT.test(text) && SCRIPT_TRICK.test(text)) || META_REFRESH.test(text)))
		signals.push({
			id: "attachment_active_content",
			score: 20,
			reason: "An attached web page runs hidden code or forwards you to a website",
		});
	return signals;
}

export function analyzeAttachments(message: ParsedEmail, prepared: PreparedSpamContent): SpamSignal[] {
	const signals = webPageSignals(message, prepared);
	const risky = message.attachments.filter(isExecutableAttachment);
	if (risky.length)
		signals.push({
			id: "risky_attachment",
			score: 10,
			reason: "Message contains a potentially risky attachment",
			metadata: { count: risky.length },
		});
	return signals;
}
