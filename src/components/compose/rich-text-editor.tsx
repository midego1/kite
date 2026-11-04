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
	isInLooseRtlRun,
	nextParagraphDirection,
	paragraphDirection,
	paragraphsInRange,
	setParagraphDirection,
	wrapLooseRuns,
} from "./rich-text-direction-utils";
import type { ParagraphDirection } from "./rich-text-direction-utils";
import type { RichTextEditorProps, ToolbarCommand } from "./rich-text-editor-types";

const COMMANDS: ToolbarCommand[] = [
	{ command: "bold", label: "Bold (⌘B)", icon: Bold },
	{ command: "italic", label: "Italic (⌘I)", icon: Italic },
	{ command: "underline", label: "Underline (⌘U)", icon: Underline },
	{ command: "strikeThrough", label: "Strikethrough", icon: Strikethrough },
	{ command: "insertUnorderedList", label: "Bulleted list", icon: List },
	{ command: "insertOrderedList", label: "Numbered list", icon: ListOrdered },
	{ command: "formatBlock", label: "Quote", icon: Quote, value: "blockquote" },
];

const DIRECTIONS: Record<ParagraphDirection, { name: string; icon: ToolbarCommand["icon"] }> = {
	auto: { name: "automatic", icon: Pilcrow },
	rtl: { name: "right to left", icon: PilcrowLeft },
	ltr: { name: "left to right", icon: PilcrowRight },
};

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
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [direction, setDirection] = useState<ParagraphDirection>("auto");
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const savedRange = useRef<Range | null>(null);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (element && element.innerHTML !== value) {
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
		onChange(element?.innerHTML ?? "");
	}

	function cycleDirection() {
		const element = editorRef.current;
		if (!element) return;
		element.focus();
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) return;
		// The first line typed into an empty editor is loose text; a paragraph is needed to carry a direction.
		const touched = selection.getRangeAt(0);
		if (hasLooseContentInRange(element, touched) || paragraphsInRange(element, touched).length === 0)
			document.execCommand("formatBlock", false, "div");
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
		if (wrapLooseLine(event.currentTarget)) emit();
	}

	/** The first line typed or pasted into an empty editor has no paragraph around it; give it one once it reads right to left. */
	function wrapLooseLine(element: HTMLElement): boolean {
		if (!isInLooseRtlRun(element, window.getSelection()?.anchorNode ?? null)) return false;
		return document.execCommand("formatBlock", false, "div");
	}

	// The space the author just typed ends a web or email address: link it, keeping the caret after the space.
	function onInput(event: FormEvent<HTMLDivElement>) {
		const { inputType = "", data, isComposing } = event.nativeEvent as InputEvent;
		if (inputType === "insertText" && (data === " " || data === " ")) autolinkBeforeCaret(event.currentTarget);
		// Not while an input method is composing, and not for undo or redo: undoing the wrap would otherwise wrap again,
		// clear the redo history and keep Ctrl+Z from ever reaching the typed text.
		if (!isComposing && !inputType.startsWith("history")) wrapLooseLine(event.currentTarget);
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
	const directionLabel = `Paragraph direction: ${DIRECTIONS[direction].name}. Switch to ${DIRECTIONS[nextParagraphDirection(direction)].name}`;

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					ref={editorRef}
					id={id}
					role="textbox"
					aria-multiline="true"
					aria-label="Message body"
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
							aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}
							className="rounded-full border border-neutral-200 bg-neutral-100 px-2 text-xs leading-5 text-neutral-500 hover:bg-neutral-200"
							title={showQuoted ? "Hide quoted text" : "Show quoted text"}
						>
							•••
						</button>
						{showQuoted && (
							<div
								className="email-body mt-2 max-w-none border-l-2 border-neutral-200 pl-3 text-sm text-neutral-600"
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
					<Tooltip key={item.command} label={item.label}>
						<button
							type="button"
							aria-label={item.label}
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
				<Tooltip label="Insert link (⌘K)">
					<button
						type="button"
						aria-label="Insert link"
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLink}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<Link2 className="h-4 w-4" />
					</button>
				</Tooltip>
				<Tooltip label="Clear formatting">
					<button
						type="button"
						aria-label="Clear formatting"
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
						className="absolute bottom-full left-2 z-10 mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
					>
						<input
							autoFocus
							value={linkUrl}
							onChange={(event) => setLinkUrl(event.target.value)}
							onKeyDown={onLinkKeyDown}
							placeholder="https://example.com"
							aria-label="Link address"
							className="h-8 w-64 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
						/>
						<button
							type="button"
							onClick={applyLink}
							className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
						>
							Apply
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
