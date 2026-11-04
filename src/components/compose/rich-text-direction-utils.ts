/**
 * Text direction for the HTML composer. A paragraph that starts with Arabic, Hebrew or another right-to-left
 * script carries `dir="auto"`, so it reads right to left in the editor, in the draft and in what is sent, while an
 * English paragraph next to it stays left to right. Left-to-right mail is never touched: nothing is added unless a
 * paragraph needs it, so existing drafts and the HTML of English messages stay byte for byte the same.
 */

export type ParagraphDirection = "auto" | "rtl" | "ltr";

/** Blocks that hold a paragraph of text. Lists are included because their padding and markers follow `dir`. */
const PARAGRAPH_SELECTOR = "div,p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol";
const LIST_TAGS = new Set(["ul", "ol"]);
const BLOCK_TAGS = new Set(PARAGRAPH_SELECTOR.split(",").concat(["table", "tr", "td", "th", "hr"]));

// Hebrew, Arabic, Syriac, Thaana, NKo and the other right-to-left blocks, the presentation forms and the right-to-left mark.
const RTL_RANGE = /[֐-ࣿיִ-﷿ﹰ-﻿‏]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * True when the text holds any right-to-left character, a quick test before anything is parsed.
 * @public Exercised by the unit tests.
 */
export function hasRtlCharacters(text: string): boolean {
	return RTL_RANGE.test(text);
}

/**
 * The direction of the first strong character (a letter or a direction mark), as the browser resolves `dir="auto"`.
 * @public Exercised by the unit tests.
 */
export function firstStrongDirection(text: string): "rtl" | "ltr" | null {
	for (const character of text) {
		if (character === "‏") return "rtl";
		if (character === "‎") return "ltr";
		if (!LETTER.test(character)) continue;
		return RTL_RANGE.test(character) ? "rtl" : "ltr";
	}
	return null;
}

function isBlock(node: Node): boolean {
	return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName.toLowerCase());
}

/** The text a paragraph shows itself: its inline content, not that of the blocks inside it or of an isolated `dir` span. */
function ownText(element: Element): string {
	if (LIST_TAGS.has(element.tagName.toLowerCase())) return element.textContent ?? "";
	let text = "";
	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
		else if (child.nodeType === Node.ELEMENT_NODE && !isBlock(child) && !(child as Element).hasAttribute("dir"))
			text += ownText(child as Element);
	}
	return text;
}

/**
 * Gives each paragraph that needs it `dir="auto"`, in place, and returns how many it changed. A paragraph needs it when
 * it starts with a right-to-left letter, or when it starts with a left-to-right one inside a block that has a direction
 * (an English item in an Arabic list would otherwise inherit right to left). A list takes `rtl` or `ltr` outright. Paragraphs that already have a `dir` keep it.
 */
export function applyAutoDirection(root: Element): number {
	if (!hasRtlCharacters(root.textContent ?? "")) return 0;
	let changed = 0;
	// Document order, so a list that has just received its direction is seen by the items inside it.
	for (const element of Array.from(root.querySelectorAll(PARAGRAPH_SELECTOR))) {
		if (element.hasAttribute("dir")) continue;
		const strong = firstStrongDirection(ownText(element));
		if (!strong) continue;
		// The root's own `dir` (the editor sets `dir="auto"` on it) is not an inherited direction a paragraph must undo.
		const inherited = element.parentElement?.closest("[dir]");
		if (strong === "rtl" || (inherited && inherited !== root && root.contains(inherited))) {
			// A list is given the direction its text starts with: `auto` would see nothing to resolve, because the items
			// carry a `dir` of their own and an element's `auto` skips descendants that have one.
			const list = LIST_TAGS.has(element.tagName.toLowerCase());
			element.setAttribute("dir", list ? strong : "auto");
			changed += 1;
		}
	}
	return changed;
}

/**
 * Wrap each run of loose text and inline elements that starts right to left in `<div dir="auto">`. The first line typed
 * into an empty editor is such a run: it has no block around it that could carry a direction.
 */
export function wrapLooseRuns(root: Element): number {
	let changed = 0;
	let run: Node[] = [];
	const flush = () => {
		const first = run[0];
		const text = run.map((node) => node.textContent ?? "").join("");
		if (first && firstStrongDirection(text) === "rtl") {
			const wrapper = root.ownerDocument.createElement("div");
			wrapper.setAttribute("dir", "auto");
			root.insertBefore(wrapper, first);
			for (const node of run) wrapper.appendChild(node);
			changed += 1;
		}
		run = [];
	};
	for (const child of Array.from(root.childNodes)) {
		if (isBlock(child)) flush();
		else run.push(child);
	}
	flush();
	return changed;
}

/**
 * Composed HTML with the right directions in it, for drafts and for what is sent. Returns the very same string
 * when nothing is right to left, or every right-to-left paragraph already has its direction. `wrapLooseText` puts
 * loose text that starts right to left in a paragraph so it can carry `dir`.
 */
export function withAutoDirection(html: string, { wrapLooseText = true }: { wrapLooseText?: boolean } = {}): string {
	if (!html || typeof DOMParser === "undefined" || !hasRtlCharacters(html)) return html;
	const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
	const changed = (wrapLooseText ? wrapLooseRuns(body) : 0) + applyAutoDirection(body);
	return changed > 0 ? body.innerHTML : html;
}

/** The paragraph blocks (no other block inside) that the range touches, the targets of the direction button. */
export function paragraphsInRange(root: Element, range: Range): HTMLElement[] {
	const found: HTMLElement[] = [];
	for (const element of Array.from(root.querySelectorAll<HTMLElement>(PARAGRAPH_SELECTOR))) {
		if (LIST_TAGS.has(element.tagName.toLowerCase())) continue;
		if (element.querySelector(PARAGRAPH_SELECTOR)) continue;
		if (range.intersectsNode(element)) found.push(element);
	}
	return found;
}

/** What a paragraph says about its own direction: no `dir` and `dir="auto"` both follow the text. */
export function paragraphDirection(element: Element): ParagraphDirection {
	const value = element.getAttribute("dir")?.toLowerCase();
	return value === "rtl" || value === "ltr" ? value : "auto";
}

/** The button cycles automatic, right to left, left to right and back. */
export function nextParagraphDirection(current: ParagraphDirection): ParagraphDirection {
	if (current === "auto") return "rtl";
	return current === "rtl" ? "ltr" : "auto";
}

/** Sets a paragraph's direction. Automatic drops an explicit `dir` and lets the text decide again. */
export function setParagraphDirection(element: Element, direction: ParagraphDirection): void {
	if (direction === "auto") element.removeAttribute("dir");
	else element.setAttribute("dir", direction);
}

/** True when the node is loose text, or sits inside a loose inline element, of a run (see `wrapLooseRuns`) that starts right to left. */
export function isInLooseRtlRun(root: Element, node: Node | null): boolean {
	let top: Node | null = node;
	while (top && top.parentNode !== root) top = top.parentNode;
	if (!top || isBlock(top)) return false;
	let first: Node = top;
	while (first.previousSibling && !isBlock(first.previousSibling)) first = first.previousSibling;
	let text = "";
	for (let next: Node | null = first; next && !isBlock(next); next = next.nextSibling) text += next.textContent ?? "";
	return firstStrongDirection(text) === "rtl";
}
