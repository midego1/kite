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

/** What the browser reads for `dir="auto"`: all text below the element except subtrees that have a `dir` of their own. */
function autoText(element: Element): string {
	let text = "";
	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
		else if (child.nodeType === Node.ELEMENT_NODE && !(child as Element).hasAttribute("dir"))
			text += autoText(child as Element);
	}
	return text;
}

function resolvedDirection(element: Element): "rtl" | "ltr" {
	const value = element.getAttribute("dir")?.toLowerCase();
	if (value === "rtl" || value === "ltr") return value;
	return firstStrongDirection(autoText(element)) ?? "ltr";
}

/** True when the nearest ancestor with a `dir` (below the root) reads right to left, so a child would inherit that. */
function inheritsRtl(element: Element, root: Element): boolean {
	const ancestor = element.parentElement?.closest("[dir]");
	return !!ancestor && ancestor !== root && root.contains(ancestor) && resolvedDirection(ancestor) === "rtl";
}

/**
 * A list is given the direction its first item reads in, as `rtl` or `ltr` outright: `auto` would see nothing to
 * resolve, because the items carry a `dir` of their own and an element's `auto` skips descendants that have one. It is
 * recomputed every time, so a list whose Arabic is replaced by English goes back to left to right.
 */
function syncListDirection(list: Element, root: Element): number {
	const first = Array.from(list.children).find((child) => child.tagName.toLowerCase() === "li");
	const explicit = first ? paragraphDirection(first) : "auto";
	const text = firstStrongDirection(list.textContent ?? "");
	const desired = explicit !== "auto" ? explicit : text;
	if (!desired) return 0;
	const wanted = desired === "rtl" || explicit !== "auto" || inheritsRtl(list, root) ? desired : null;
	if (list.getAttribute("dir") === wanted) return 0;
	if (wanted) list.setAttribute("dir", wanted);
	else list.removeAttribute("dir");
	return 1;
}

/**
 * Gives each paragraph that needs it `dir="auto"`, in place, and returns how many it changed. A paragraph needs it when
 * it starts with a right-to-left letter, or when it starts with a left-to-right one inside a block that reads right to
 * left (an English item in an Arabic list would otherwise inherit that). Paragraphs that already have a `dir` keep it,
 * lists follow their first item. With `quote`, which is for mail someone else wrote, only right-to-left paragraphs with
 * no other block inside get a `dir`: nothing else of the original's direction is touched.
 */
export function applyAutoDirection(root: Element, { quote = false }: { quote?: boolean } = {}): number {
	if (!hasRtlCharacters(root.textContent ?? "") && !root.querySelector("[dir]")) return 0;
	let changed = 0;
	// Document order, so a list that has just received its direction is seen by the items inside it.
	for (const element of Array.from(root.querySelectorAll(PARAGRAPH_SELECTOR))) {
		if (LIST_TAGS.has(element.tagName.toLowerCase())) {
			if (!quote) changed += syncListDirection(element, root);
			continue;
		}
		if (element.hasAttribute("dir")) continue;
		if (quote && element.querySelector(PARAGRAPH_SELECTOR)) continue;
		const strong = firstStrongDirection(ownText(element));
		if (!strong) continue;
		if (strong === "rtl" || (!quote && inheritsRtl(element, root))) {
			element.setAttribute("dir", "auto");
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
 * loose text that starts right to left in a paragraph so it can carry `dir`; `quote` is for someone else's mail
 * (see `applyAutoDirection`).
 */
export function withAutoDirection(
	html: string,
	{ wrapLooseText = true, quote = false }: { wrapLooseText?: boolean; quote?: boolean } = {},
): string {
	if (!html || typeof DOMParser === "undefined" || !(hasRtlCharacters(html) || /\bdir\s*=/i.test(html))) return html;
	const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
	const changed = (wrapLooseText ? wrapLooseRuns(body) : 0) + applyAutoDirection(body, { quote });
	return changed > 0 ? body.innerHTML : html;
}

/**
 * What goes out: every `dir="auto"` becomes the `rtl` or `ltr` the browser would have resolved it to, or goes when the
 * text has no letter to decide by. Not every mail client understands `auto`; drafts and the preview keep it, so the
 * paragraph still follows what is typed until the message is sent.
 */
export function resolveAutoDirections(html: string): string {
	if (!html || typeof DOMParser === "undefined" || !/\bdir\s*=\s*["']?auto/i.test(html)) return html;
	const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
	const autos = Array.from(body.querySelectorAll("[dir]")).filter(
		(element) => element.getAttribute("dir")?.toLowerCase() === "auto",
	);
	if (autos.length === 0) return html;
	// Decided first: an element's `auto` ignores descendants that have a `dir`, whatever its value.
	const decided = autos.map((element) => [element, firstStrongDirection(autoText(element))] as const);
	for (const [element, direction] of decided) {
		if (direction) element.setAttribute("dir", direction);
		else element.removeAttribute("dir");
	}
	return body.innerHTML;
}

/** True when a non-empty range stops at the very start of the block: a triple-click ends at offset 0 of the next one. */
function endsAtStartOf(element: Element, range: Range): boolean {
	if (range.collapsed || !element.contains(range.endContainer) || element.contains(range.startContainer)) return false;
	const head = element.ownerDocument.createRange();
	head.setStart(element, 0);
	head.setEnd(range.endContainer, range.endOffset);
	const content = head.cloneContents();
	return (content.textContent ?? "") === "" && !content.querySelector("br,img");
}

/** The paragraph blocks (no other block inside) that the range touches, the targets of the direction button. */
export function paragraphsInRange(root: Element, range: Range): HTMLElement[] {
	const found: HTMLElement[] = [];
	for (const element of Array.from(root.querySelectorAll<HTMLElement>(PARAGRAPH_SELECTOR))) {
		if (LIST_TAGS.has(element.tagName.toLowerCase())) continue;
		if (element.querySelector(PARAGRAPH_SELECTOR)) continue;
		if (range.intersectsNode(element) && !endsAtStartOf(element, range)) found.push(element);
	}
	return found;
}

/** True when text sits directly in the root, with no paragraph around it, inside the range: the loose first line. */
export function hasLooseContentInRange(root: Element, range: Range): boolean {
	return Array.from(root.childNodes).some(
		(child) => !isBlock(child) && (child.textContent ?? "").trim() !== "" && range.intersectsNode(child),
	);
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
