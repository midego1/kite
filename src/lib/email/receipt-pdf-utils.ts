import type { TextPdfBlock, TextPdfDocument } from "@/lib/pdf/text-pdf-types";
import { htmlToReadableText } from "./reply-content-utils";

/** A quoted paragraph's text and its quote depth, as `paragraphsFromText` in `message-pdf-utils.ts` reads it. */
type BodyParagraph = { text: string; depth: number };

const BODY_SIZE = 10.5;
const QUOTE_INDENT = 12;

/**
 * The readable copy as plain-text paragraphs; `>`-quoted lines keep their depth as an indent. Pure and DOM-free
 * (unlike `paragraphsFromHtml` in `message-pdf-utils.ts`, which needs a browser's `DOMParser`), so it runs on
 * Workers and Node alike — the reason a receipt PDF can be built reliably on both runtimes.
 */
export function paragraphsFromReadableText(text: string): BodyParagraph[] {
	return text
		.replace(/\r\n?/g, "\n")
		.trimEnd()
		.split("\n")
		.map((line) => {
			const quote = /^((?:>\s?)+)/.exec(line);
			const depth = quote ? (quote[1].match(/>/g) ?? []).length : 0;
			return { text: quote ? line.slice(quote[1].length) : line, depth };
		});
}

function bodyBlocks(paragraphs: BodyParagraph[]): TextPdfBlock[] {
	return paragraphs.map((paragraph, index) => ({
		text: paragraph.text,
		size: BODY_SIZE,
		grey: paragraph.depth > 0 ? 0.4 : 0,
		indent: Math.min(paragraph.depth, 6) * QUOTE_INDENT,
		spaceBefore: index === 0 ? 0 : 4,
	}));
}

export type ReceiptPdfHeader = {
	fromName: string | null;
	fromAddress: string;
	subject: string | null;
	dateText: string;
};

/**
 * The receipt PDF's document: a plain header (From, date, subject) and the message's readable text, the same
 * extraction already used for search and triage (`htmlToReadableText`), as paragraphs. Text only — images and
 * styling are left to the HTML copy, which keeps the original layout.
 */
export function buildReceiptPdfDocument(
	header: ReceiptPdfHeader,
	textBody: string | null,
	htmlBody: string | null,
): TextPdfDocument {
	const subject = header.subject?.trim() || "(no subject)";
	const from = header.fromName ? `${header.fromName} <${header.fromAddress}>` : header.fromAddress;
	const body = textBody || htmlToReadableText(htmlBody);
	const blocks: TextPdfBlock[] = [
		{ text: subject, size: 16, bold: true },
		{ text: `From: ${from}`, size: 9.5, grey: 0.3, spaceBefore: 8 },
		{ text: `Date: ${header.dateText}`, size: 9.5, grey: 0.3 },
		{ rule: true, spaceBefore: 14 },
		...bodyBlocks(paragraphsFromReadableText(body)).map((block, index) =>
			index === 0 ? { ...block, spaceBefore: 12 } : block,
		),
	];
	return { title: subject, blocks };
}
