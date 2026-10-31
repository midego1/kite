"use client";

import toast from "react-hot-toast";
import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { formatUserDate } from "@/lib/time/utils";
import { buildPrintDocument, pdfFileName, toPrintMessage } from "./print-document-utils";
import type { ReaderPrint } from "./print-menu-types";
import type { PrintDocumentInput, PrintSource } from "./print-types";

const FRAME_ID = "kite-print-frame";
// No scripts. `allow-same-origin` lets Kite call print() on the frame and load inline attachments with the session
// cookie; `allow-modals` is what print() needs inside a sandbox.
const PRINT_FRAME_SANDBOX = "allow-same-origin allow-modals";

const PRINT_DATE: Intl.DateTimeFormatOptions = {
	weekday: "short",
	day: "numeric",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
};

function printDocumentInput(sources: PrintSource[]): PrintDocumentInput {
	const messages = sources.map((source) =>
		toPrintMessage(source, { sanitize: sanitizeEmailHtml, formatDate: (value) => formatUserDate(value, PRINT_DATE) }),
	);
	return { title: messages[0]?.subject ?? "", messages };
}

/**
 * Prints through an off-screen, sandboxed frame holding only the print document, so no app chrome is printed and the
 * app's theme does not apply. The previous frame is removed at the next print rather than after this one, because
 * Safari's print() returns before its dialog closes.
 */
function printInFrame(html: string): Promise<void> {
	return new Promise((resolve, reject) => {
		document.getElementById(FRAME_ID)?.remove();
		const frame = document.createElement("iframe");
		frame.id = FRAME_ID;
		frame.title = "Print preview";
		frame.setAttribute("sandbox", PRINT_FRAME_SANDBOX);
		frame.setAttribute("aria-hidden", "true");
		frame.tabIndex = -1;
		frame.referrerPolicy = "no-referrer";
		// Off screen but laid out at a page's size: Firefox and Safari can print a zero-sized or hidden frame blank.
		Object.assign(frame.style, {
			position: "fixed",
			top: "0",
			left: "-10000px",
			width: "210mm",
			height: "297mm",
			border: "0",
			pointerEvents: "none",
		});
		// The load event waits for the document's images, so they are on the page when it prints.
		frame.addEventListener(
			"load",
			() => {
				const view = frame.contentWindow;
				if (!view) return reject(new Error("The print preview could not open."));
				// Focus goes back where it was, so the reader's keys keep working after the dialog.
				const previous = document.activeElement;
				try {
					view.focus();
					view.print();
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
				}
			},
			{ once: true },
		);
		frame.srcdoc = html;
		document.body.appendChild(frame);
	});
}

/** Opens the print dialog for the messages, oldest first as given. */
export async function printMessages(sources: PrintSource[]): Promise<void> {
	if (!sources.length) return;
	try {
		await printInFrame(buildPrintDocument(printDocumentInput(sources)));
	} catch (error) {
		console.error(error);
		toast.error("Could not open the print dialog.", { id: "message-print" });
	}
}

function saveFile(bytes: Uint8Array, fileName: string) {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Safari starts the download after the click returns; revoking at once would cancel it.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Saves the messages as a text PDF named after the subject. The writer is loaded on first use. When the mail uses
 * characters the standard PDF fonts lack, the file is still saved and a notice points at Print → Save as PDF.
 */
export async function downloadMessagesPdf(sources: PrintSource[]): Promise<void> {
	if (!sources.length) return;
	try {
		const input = printDocumentInput(sources);
		const { buildMessagePdf } = await import("./message-pdf");
		const pdf = buildMessagePdf(input);
		saveFile(pdf.bytes, pdfFileName(input.title));
		if (pdf.lost > 0)
			toast(
				"Some characters or emoji could not be included in the PDF. For an exact copy, use Print and choose Save as PDF.",
				{ id: "message-pdf-lossy", duration: 8000 },
			);
	} catch (error) {
		console.error(error);
		toast.error("Could not create the PDF.", { id: "message-pdf" });
	}
}

/** The reader's Ctrl/Cmd+P: prints what its menu's Print would, or is left unbound without `print`. */
export function printShortcutAction(print: ReaderPrint | undefined): (() => void) | undefined {
	return print ? () => void printMessages(print.getSources()) : undefined;
}
