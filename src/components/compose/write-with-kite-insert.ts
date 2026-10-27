import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { hasMeaningfulHtml } from "./rich-text-utils";
import type { WriteWithKiteComposer, WriteWithKiteSelection } from "./write-with-kite-types";
import { composeTextToHtml, replaceBody, splitSignature, withOriginalBelow } from "./write-with-kite-utils";

type InsertInput = {
	editorId: string;
	mode: "write" | "rewrite";
	composer: WriteWithKiteComposer;
	selection: WriteWithKiteSelection | null;
	text: string;
	/** The rewritten text as HTML, for a translation that keeps the original below. */
	originalHtml: string | null;
	/** The body (without the signature) when the request was sent. */
	bodyAtRequest: string;
	/** Add the text after the body instead of replacing the selection or the body. */
	below: boolean;
};

/** Whether the selection the panel opened with is still in the editor with the same text. */
function selectionIntact(editorId: string, selection: WriteWithKiteSelection | null): boolean {
	if (!selection) return false;
	const editor = document.getElementById(editorId);
	return !!editor?.contains(selection.range.startContainer) && selection.range.toString() === selection.text;
}

/**
 * Whether the text can replace what it was written for: the selection is unchanged, or (without a selection) the
 * body is as it was when the request was sent. Otherwise it is added below, so nothing typed meanwhile is lost.
 */
export function canReplace(input: Pick<InsertInput, "editorId" | "composer" | "selection" | "bodyAtRequest">): boolean {
	if (input.selection) return selectionIntact(input.editorId, input.selection);
	return splitSignature(input.composer.html).body === input.bodyAtRequest;
}

/**
 * Puts checked text into the editor as sanitized HTML and returns the editor HTML afterwards: in place of an intact
 * selection (through the browser's editing, so its undo works too), in place of an unchanged body that holds no
 * images or other content, or else after the body. The signature block always stays last.
 */
export function insertComposeText(input: InsertInput): string {
	const { editorId, composer, selection, text, originalHtml } = input;
	const generated = composeTextToHtml(text);
	const html =
		sanitizeEmailHtml(originalHtml === null ? generated : withOriginalBelow(generated, originalHtml), {
			forOutgoing: true,
		}) ?? "";
	const replace = !input.below && canReplace(input);
	const editor = document.getElementById(editorId);
	if (selection && replace && editor) {
		editor.focus();
		const current = window.getSelection();
		current?.removeAllRanges();
		current?.addRange(selection.range);
		// The editor reports the new HTML on the input event this fires.
		document.execCommand("insertHTML", false, html);
		return editor.innerHTML;
	}
	const body = splitSignature(composer.html).body;
	// A new email replaces the body only while it holds nothing, not even an image; a rewrite replaces the text it was.
	const replaceAll = replace && (input.mode === "rewrite" || !hasMeaningfulHtml(body));
	const next = replaceBody(composer.html, replaceAll ? html : `${body}${html}`);
	composer.setHtml(next);
	return next;
}
