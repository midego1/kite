import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import type { WriteWithKiteComposer, WriteWithKiteSelection } from "./write-with-kite-types";
import { composeTextToHtml, replaceBody, splitSignature, withOriginalBelow } from "./write-with-kite-utils";

type InsertInput = {
	editorId: string;
	composer: WriteWithKiteComposer;
	selection: WriteWithKiteSelection | null;
	text: string;
	/** The rewritten text as HTML, for a translation that keeps the original below. */
	originalHtml: string | null;
	/** Add the text after the body instead of replacing the selection or the body. */
	below: boolean;
};

/** Whether the selection the panel opened with is still in the editor with the same text. */
export function selectionIntact(editorId: string, selection: WriteWithKiteSelection | null): boolean {
	if (!selection) return false;
	const editor = document.getElementById(editorId);
	return !!editor?.contains(selection.range.startContainer) && selection.range.toString() === selection.text;
}

/**
 * Puts checked text into the editor as sanitized HTML: in place of an intact selection (through the browser's
 * editing, so its undo works too), in place of the body, or after it. The signature block always stays last.
 */
export function insertComposeText({ editorId, composer, selection, text, originalHtml, below }: InsertInput) {
	const generated = composeTextToHtml(text);
	const html =
		sanitizeEmailHtml(originalHtml === null ? generated : withOriginalBelow(generated, originalHtml), {
			forOutgoing: true,
		}) ?? "";
	const editor = document.getElementById(editorId);
	if (selection && !below && editor && selectionIntact(editorId, selection)) {
		editor.focus();
		const current = window.getSelection();
		current?.removeAllRanges();
		current?.addRange(selection.range);
		// The editor reports the new HTML on the input event this fires.
		document.execCommand("insertHTML", false, html);
		return;
	}
	const body = splitSignature(composer.html).body;
	composer.setHtml(replaceBody(composer.html, below || selection ? `${body}${html}` : html));
}
