import { findLinks } from "./linkify-utils";
import type { LinkMatch } from "./linkify-utils";

// Text that is already a link, or that is code or a control, keeps its text as it is.
const SKIPPED_ANCESTORS = "a, code, kbd, samp, script, style, textarea, button";
const TEXT_NODE = 3;
const SHOW_TEXT = 4;

function createAnchor(doc: Document, link: LinkMatch, attributes: Record<string, string>): HTMLAnchorElement {
	const anchor = doc.createElement("a");
	anchor.setAttribute("href", link.href);
	for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
	anchor.textContent = link.text;
	return anchor;
}

/**
 * Wraps the web and email addresses in the text nodes under `root` in `<a href>`, leaving text
 * inside existing links and code alone. Returns how many links it made. `attributes` go on every
 * new anchor, for example the reader's `target` and `rel`.
 */
export function linkifyTextNodes(root: Element, attributes: Record<string, string> = {}): number {
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);

	let made = 0;
	for (const node of nodes) {
		if (node.parentElement?.closest(SKIPPED_ANCESTORS)) continue;
		const links = findLinks(node.data);
		if (!links.length) continue;
		const fragment = doc.createDocumentFragment();
		let position = 0;
		for (const link of links) {
			if (link.start > position) fragment.append(node.data.slice(position, link.start));
			fragment.append(createAnchor(doc, link, attributes));
			position = link.end;
		}
		if (position < node.data.length) fragment.append(node.data.slice(position));
		node.replaceWith(fragment);
		made += links.length;
	}
	return made;
}

/**
 * Composed HTML with the addresses the author typed turned into links, for sending. Returns the
 * input untouched when there is nothing to link, so unrelated markup is never re-serialized.
 */
export function linkifyOutgoingHtml(html: string): string {
	if (!html || typeof DOMParser === "undefined") return html;
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	return linkifyTextNodes(doc.body) > 0 ? doc.body.innerHTML : html;
}

/**
 * Links the address that ends `trailing` characters before the caret, in the editor's own text
 * node, and puts the caret back where it was. Called after the space the author typed
 * (`trailing` 1) or just before Enter (0). Returns whether it linked anything.
 */
export function autolinkBeforeCaret(editor: HTMLElement, trailing: number): boolean {
	const selection = editor.ownerDocument.defaultView?.getSelection();
	const node = selection?.anchorNode;
	if (!selection || !selection.isCollapsed || !node || node.nodeType !== TEXT_NODE || !editor.contains(node)) {
		return false;
	}
	const text = node as Text;
	if (text.parentElement?.closest(SKIPPED_ANCESTORS)) return false;
	const end = selection.anchorOffset - trailing;
	if (end <= 0) return false;
	const link = findLinks(text.data.slice(0, end)).find((candidate) => candidate.end === end);
	if (!link) return false;

	const linked = text.splitText(link.start);
	const rest = linked.splitText(link.end - link.start);
	const anchor = createAnchor(editor.ownerDocument, link, {});
	linked.replaceWith(anchor);
	selection.collapse(rest, trailing);
	return true;
}
