"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent, KeyboardEvent } from "react";
import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	Pilcrow,
	PilcrowLeft,
	PilcrowRight,
	Quote,
	RemoveFormatting,
	Strikethrough,
	Underline,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { autolinkBeforeCaret, linkHtml } from "@/lib/email/linkify-dom-utils";
import { cn } from "@/lib/utils";
import {
	applyAutoDirection,
	hasLooseContentInRange,
	findLooseRun,
	nextParagraphDirection,
	paragraphDirection,
	paragraphsInRange,
	setParagraphDirection,
	wrapLooseRuns,
} from "./rich-text-direction-utils";
import type { ParagraphDirection } from "./rich-text-direction-utils";
import type { RichTextEditorProps, ToolbarCommand } from "./rich-text-editor-types";
import { useT } from "@/lib/i18n/use-t";
import type { MessageKey } from "@/lib/i18n/i18n-types";
import { msg } from "@/lib/i18n/translator";

const COMMANDS: ToolbarCommand[] = [
	{ command: "bold", label: msg("Bold (⌘B)"), icon: Bold },
	{ command: "italic", label: msg("Italic (⌘I)"), icon: Italic },
	{ command: "underline", label: msg("Underline (⌘U)"), icon: Underline },
	{ command: "strikeThrough", label: msg("Strikethrough"), icon: Strikethrough },
	{ command: "insertUnorderedList", label: msg("Bulleted list"), icon: List },
	{ command: "insertOrderedList", label: msg("Numbered list"), icon: ListOrdered },
	{ command: "formatBlock", label: msg("Quote"), icon: Quote, value: "blockquote" },
];

const DIRECTIONS: Record<ParagraphDirection, { name: MessageKey; icon: ToolbarCommand["icon"] }> = {
	auto: { name: msg("paragraph|automatic"), icon: Pilcrow },
	rtl: { name: msg("right to left"), icon: PilcrowLeft },
	ltr: { name: msg("left to right"), icon: PilcrowRight },
};

/** How many characters of the editor's text come before a selection point. */
function characterOffset(root: HTMLElement, node: Node | null, offset: number): number {
	if (!node || !root.contains(node)) return 0;
	const range = document.createRange();
	range.selectNodeContents(root);
	range.setEnd(node, offset);
	return range.toString().length;
}

/** The point itself when its node is still in the editor and still long enough. */
function pointKept(root: HTMLElement, node: Node | null, offset: number): { node: Node; offset: number } | null {
	const length = node?.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : (node?.childNodes.length ?? 0);
	return node?.isConnected && root.contains(node) && offset <= length ? { node, offset } : null;
}

/** The text position that many characters into the editor; the end of the text when it is past it. */
function pointAtCharacter(root: HTMLElement, characters: number): { node: Node; offset: number } | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let seen = 0;
	let last: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (characters < seen + node.length) return { node, offset: characters - seen };
		seen += node.length;
		last = node;
	}
	return last ? { node: last, offset: last.length } : null;
}

/** The paragraph the caret is in: the first one a selection touches. */
function currentParagraphDirection(root: HTMLElement): ParagraphDirection {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return "auto";
	const [first] = paragraphsInRange(root, selection.getRangeAt(0));
	return first ? paragraphDirection(first) : "auto";
}

/**
 * A small HTML editor built on contentEditable. It stays deliberately light:
 * inline styles, lists, quotes and links, with pasted content flattened to
 * text so a message never carries another site's markup.
 */
export function RichTextEditor({
	id,
	value,
	onChange,
	quotedHtml,
	disabled,
	placeholder,
	className,
	toolbarStart,
	toolbarEnd,
	footerContent,
}: RichTextEditorProps) {
	const t = useT();
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [direction, setDirection] = useState<ParagraphDirection>("auto");
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const savedRange = useRef<Range | null>(null);
	// The last value the editor emitted itself. When it comes back as the value, the DOM already holds it, even if a
	// browser extension added attributes since, so rewriting it would only move the caret to the start.
	const lastEmitted = useRef<string | null>(null);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (!element || (lastEmitted.current !== null && value === lastEmitted.current)) return;
		lastEmitted.current = null;
		if (element.innerHTML !== value) {
			element.innerHTML = value;
			// Text that arrives from a template, a draft or the assistant flows from the right straight away too.
			wrapLooseRuns(element);
			applyAutoDirection(element);
		}
	}, [value]);

	useEffect(() => {
		function refresh() {
			const element = editorRef.current;
			if (!element || !element.contains(document.activeElement)) return;
			const next: Record<string, boolean> = {};
			for (const item of COMMANDS) {
				if (item.command === "formatBlock") {
					next[item.command] = document.queryCommandValue("formatBlock").toLowerCase() === "blockquote";
				} else {
					next[item.command] = document.queryCommandState(item.command);
				}
			}
			setActive(next);
			setDirection(currentParagraphDirection(element));
		}
		document.addEventListener("selectionchange", refresh);
		return () => document.removeEventListener("selectionchange", refresh);
	}, []);

	// A paragraph that starts right to left gets `dir="auto"` as soon as it is typed, so it flows from the right and
	// is sent that way. Only attributes change, so the caret and the undo history stay where they are.
	function emit() {
		const element = editorRef.current;
		if (element) applyAutoDirection(element);
		const output = element?.innerHTML ?? "";
		lastEmitted.current = output;
		onChange(output);
	}

	function cycleDirection() {
		const element = editorRef.current;
		if (!element) return;
		element.focus();
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) return;
		// The first line typed into an empty editor is loose text; a paragraph is needed to carry a direction.
		const touched = selection.getRangeAt(0);
		if (hasLooseContentInRange(element, touched)) wrapLooseText(element, { onlyRtl: false });
		else if (paragraphsInRange(element, touched).length === 0) document.execCommand("formatBlock", false, "div");
		const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
		const paragraphs = range ? paragraphsInRange(element, range) : [];
		const [first] = paragraphs;
		if (!first) return;
		const next = nextParagraphDirection(paragraphDirection(first));
		for (const paragraph of paragraphs) setParagraphDirection(paragraph, next);
		setDirection(next);
		emit();
	}

	function run(command: string, commandValue?: string) {
		editorRef.current?.focus();
		if (command === "formatBlock" && active.formatBlock) {
			document.execCommand("formatBlock", false, "div");
		} else {
			document.execCommand(command, false, commandValue);
		}
		emit();
	}

	function openLink() {
		const selection = window.getSelection();
		savedRange.current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		setLinkUrl("");
		setLinkOpen(true);
	}

	function applyLink() {
		const url = linkUrl.trim();
		setLinkOpen(false);
		if (!url) return;
		const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
		editorRef.current?.focus();
		const selection = window.getSelection();
		if (savedRange.current && selection) {
			selection.removeAllRanges();
			selection.addRange(savedRange.current);
		}
		if (selection && selection.isCollapsed) {
			document.execCommand("insertHTML", false, linkHtml(href));
		} else {
			document.execCommand("createLink", false, href);
		}
		emit();
	}

	function onLinkKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
		// Enter would otherwise submit the compose form.
		event.preventDefault();
		event.stopPropagation();
		applyLink();
	}

	function onPaste(event: ClipboardEvent<HTMLDivElement>) {
		event.preventDefault();
		const text = event.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, text);
		// The insert's own input event ran inside this command, where a second command is refused: wrap the line now.
		if (wrapLooseText(event.currentTarget, { onlyRtl: true })) emit();
	}

	/**
	 * The first line typed or pasted into an empty editor has no paragraph around it, so it cannot carry a direction. Each
	 * run of loose text is given one with `formatBlock` (which keeps the undo history), one run at a time, with the
	 * caret put at its start so that nothing else the selection holds is turned into a plain div; then the selection is
	 * put back. With `onlyRtl`, only text that reads right to left is wrapped. Returns true when something was wrapped.
	 */
	function wrapLooseText(element: HTMLElement, { onlyRtl }: { onlyRtl: boolean }): boolean {
		const selection = window.getSelection();
		let run = findLooseRun(element, { onlyRtl });
		if (!selection || !run) return false;
		const before = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] as const;
		const anchorAt = characterOffset(element, before[0], before[1]);
		const focusAt = characterOffset(element, before[2], before[3]);
		let wrapped = false;
		// A few runs at most; a refused command leaves the run where it is, so stop rather than ask again.
		for (let attempts = 0; run && attempts < 10; attempts += 1) {
			selection.collapse(run, 0);
			if (!document.execCommand("formatBlock", false, "div")) break;
			wrapped = true;
			run = findLooseRun(element, { onlyRtl });
		}
		// The command may have replaced the text nodes the selection sat in: put it back by character position.
		// A node that is still there keeps its place, so a caret at the end of one line does not move to the next.
		const anchor = pointKept(element, before[0], before[1]) ?? pointAtCharacter(element, anchorAt);
		const focus = pointKept(element, before[2], before[3]) ?? pointAtCharacter(element, focusAt);
		if (anchor && focus) selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
		return wrapped;
	}

	// The space the author just typed ends a web or email address: link it, keeping the caret after the space.
	function onInput(event: FormEvent<HTMLDivElement>) {
		const { inputType = "", data, isComposing } = event.nativeEvent as InputEvent;
		if (inputType === "insertText" && (data === " " || data === " ")) autolinkBeforeCaret(event.currentTarget);
		// Not while an input method is composing, and not for undo or redo: undoing the wrap would otherwise wrap again,
		// clear the redo history and keep Ctrl+Z from ever reaching the typed text.
		if (!isComposing && !inputType.startsWith("history")) wrapLooseText(event.currentTarget, { onlyRtl: true });
		emit();
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) autolinkBeforeCaret(event.currentTarget);
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openLink();
		}
	}

	const DirectionIcon = DIRECTIONS[direction].icon;
	const directionLabel = t("Paragraph direction: {current}. Switch to {next}", {
		current: t(DIRECTIONS[direction].name),
		next: t(DIRECTIONS[nextParagraphDirection(direction)].name),
	});

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					ref={editorRef}
					id={id}
					role="textbox"
					aria-multiline="true"
					aria-label={t("Message body")}
					contentEditable={!disabled}
					suppressContentEditableWarning
					data-placeholder={placeholder}
					onInput={onInput}
					onBlur={emit}
					onPaste={onPaste}
					onKeyDown={onKeyDown}
					className={cn(
						"email-body composer-body reading-text max-w-none grow shrink-0 px-4 py-3 text-sm text-neutral-900 outline-none",
						"min-h-32 empty:before:pointer-events-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]",
						disabled && "cursor-not-allowed opacity-60",
					)}
				/>
				{quotedHtml && (
					<div className="shrink-0 px-4 pb-3">
						<button
							type="button"
							onClick={() => setShowQuoted((open) => !open)}
							aria-expanded={showQuoted}
							aria-label={showQuoted ? t("Hide quoted text") : t("Show quoted text")}
							className="rounded-full border border-neutral-200 bg-neutral-100 px-2 text-xs leading-5 text-neutral-500 hover:bg-neutral-200"
							title={showQuoted ? t("Hide quoted text") : t("Show quoted text")}
						>
							•••
						</button>
						{showQuoted && (
							<div
								className="email-body mt-2 max-w-none border-s-2 border-neutral-200 ps-3 text-sm text-neutral-600"
								dangerouslySetInnerHTML={{ __html: quotedHtml }}
							/>
						)}
					</div>
				)}
			</div>
			{footerContent}
			<div className="relative flex items-center gap-0.5 border-t border-neutral-100 px-4 py-3">
				{toolbarStart}
				{COMMANDS.map((item) => (
					<Tooltip key={item.command} label={t(item.label)}>
						<button
							type="button"
							aria-label={t(item.label)}
							aria-pressed={!!active[item.command]}
							disabled={disabled}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => run(item.command, item.value)}
							className={cn(
								"rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
								active[item.command] && "bg-neutral-200 text-neutral-900",
							)}
						>
							<item.icon className="h-4 w-4" />
						</button>
					</Tooltip>
				))}
				<Tooltip label={directionLabel}>
					<button
						type="button"
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={cycleDirection}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<DirectionIcon className="h-4 w-4" aria-hidden="true" />
						{/* The name is the button's content, not an aria-label: a label lookup for "To" would find it. */}
						<span className="sr-only">{directionLabel}</span>
					</button>
				</Tooltip>
				<Tooltip label={t("Insert link (⌘K)")}>
					<button
						type="button"
						aria-label={t("Insert link")}
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLink}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<Link2 className="h-4 w-4" />
					</button>
				</Tooltip>
				<Tooltip label={t("Clear formatting")}>
					<button
						type="button"
						aria-label={t("Clear formatting")}
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => run("removeFormat")}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<RemoveFormatting className="h-4 w-4" />
					</button>
				</Tooltip>
				{toolbarEnd}
				{/* Not a <form>: the editor sits inside the compose form, and a nested form's submit
				    bubbles through React to the composer and sends the message. */}
				{linkOpen && (
					<div
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== "Escape") return;
							// Keys that confirm or cancel an IME composition belong to the input method, but must not
							// reach the composer, which would submit or leave its modal mode.
							if (event.nativeEvent.isComposing) {
								event.stopPropagation();
								return;
							}
							if (event.key !== "Escape") return;
							event.preventDefault();
							event.stopPropagation();
							setLinkOpen(false);
						}}
						className="absolute bottom-full start-2 z-10 mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
					>
						<input
							autoFocus
							value={linkUrl}
							onChange={(event) => setLinkUrl(event.target.value)}
							onKeyDown={onLinkKeyDown}
							placeholder="https://example.com"
							aria-label={t("Link address")}
							className="h-8 w-64 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
						/>
						<button
							type="button"
							onClick={applyLink}
							className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
						>
							{t("Apply")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
