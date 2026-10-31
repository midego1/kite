import { LINK_TAIL, findLinks } from "./linkify-utils";
import type { LinkMatch } from "./linkify-utils";

// Text that is already a link, or that is code or a control, keeps its text as it is.
const SKIPPED_ANCESTORS = "a, code, kbd, samp, script, style, textarea, button";
const TEXT_NODE = 3;
const SHOW_TEXT = 4;

function createAnchor(
	doc: Document,
	link: Pick<LinkMatch, "href" | "text">,
	attributes: Record<string, string>,
): HTMLAnchorElement {
	const anchor = doc.createElement("a");
	anchor.setAttribute("href", link.href);
	for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
	anchor.textContent = link.text;
	return anchor;
}

/**
 * The anchor Insert link puts at the caret. The address is untrusted text, so the element is built with DOM calls and
 * serialised: a quote or `<` in it can never close the attribute or start markup (upstream Mailflare #221).
 */
export function linkHtml(href: string, doc: Document = document): string {
	return createAnchor(doc, { href, text: href }, {}).outerHTML;
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
		// The links first: most text nodes have none, and `closest` walks every ancestor of a deeply nested one.
		const links = findLinks(node.data);
		if (!links.length || node.parentElement?.closest(SKIPPED_ANCESTORS)) continue;
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

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Links the address the author has just finished typing in the editor's own text node: the last
 * address before the caret, followed only by sentence punctuation and the space (or nothing, for
 * Enter) that ended it. It replaces the address and what follows with one `insertHTML` command,
 * so the browser records a single undo step and leaves the caret after the inserted text.
 * Returns whether it linked anything.
 */
export function autolinkBeforeCaret(editor: HTMLElement): boolean {
	const doc = editor.ownerDocument;
	const selection = doc.defaultView?.getSelection();
	const node = selection?.anchorNode;
	if (!selection || !selection.isCollapsed || !node || node.nodeType !== TEXT_NODE || !editor.contains(node)) {
		return false;
	}
	const text = node as Text;
	if (text.parentElement?.closest(SKIPPED_ANCESTORS)) return false;
	const caret = selection.anchorOffset;
	const before = text.data.slice(0, caret);
	const link = findLinks(before).pop();
	if (!link) return false;
	const tail = before.slice(link.end);
	if (!LINK_TAIL.test(tail)) return false;

	selection.setBaseAndExtent(text, link.start, text, caret);
	const html = `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>${escapeHtml(tail)}`;
	if (doc.execCommand("insertHTML", false, html)) return true;
	selection.collapse(text, caret);
	return false;
}
