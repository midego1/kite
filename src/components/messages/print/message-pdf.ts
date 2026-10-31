import { buildTextPdf } from "@/lib/pdf/text-pdf-utils";
import type { TextPdfResult } from "@/lib/pdf/text-pdf-types";
import { messagePdfBlocks } from "./message-pdf-utils";
import type { PrintDocumentInput } from "./print-types";

/** Loaded on the first Download PDF, so the PDF writer stays out of the reader's bundle. */
export function buildMessagePdf(input: PrintDocumentInput): TextPdfResult {
	const parser = new DOMParser();
	return buildTextPdf({
		title: input.title,
		blocks: messagePdfBlocks(input, (html) => parser.parseFromString(html, "text/html").body),
	});
}
