"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useT } from "@/lib/i18n/use-t";
import type { OpenSuggestion } from "@/hooks/open-suggestions-types";
import {
	FOCUS_REOPEN_GUARD_MS,
	hoversWith,
	previewHintId,
	PREVIEW_CLOSE_DELAY_MS,
	PREVIEW_OPEN_DELAY_MS,
} from "./suggestion-preview-utils";

const SuggestionPreviewContent = dynamic(
	// Inline so the server build drops the chunk; see suggestion-card.tsx.
	() =>
		(typeof window === "undefined" ? new Promise<never>(() => {}) : import("./suggestion-preview-content")).then(
			(module) => module.default,
		),
	{ ssr: false },
);

/**
 * A For you row (a list item) with a hover preview: after a short delay, a popover shows the suggestion's sender,
 * subject, an excerpt and the actions the reader's card offers for its kind. Keyboard focus on the row opens it
 * too, but its buttons stay out of the Tab order (Tab goes from row to row) until ArrowDown moves focus into it;
 * Escape closes it and returns focus to the row. It stays open while the pointer is in the row or the preview,
 * also when a click lands on text or on a button that takes no focus. A finger has no hover, so on touch nothing opens and the
 * row keeps opening the message. The details are only requested when it opens.
 */
export function SuggestionPreviewRow({
	suggestion,
	mailbox = null,
	children,
	...rest
}: { suggestion: OpenSuggestion; mailbox?: string | null } & HTMLAttributes<HTMLLIElement>) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	const row = useRef<HTMLLIElement>(null);
	const content = useRef<HTMLDivElement>(null);
	// Whether a mouse is over the row or the preview (a click on plain text or, in Safari, on a button blurs without a target).
	const pointerInside = useRef(false);
	// Focus given back to the row after a close (Escape) must not open the preview again.
	const ignoreFocusUntil = useRef(0);
	// Opened by keyboard focus, the preview's controls stay out of the Tab order until ArrowDown moves focus in.
	const [via, setVia] = useState<"pointer" | "key">("pointer");
	const [entered, setEntered] = useState(false);
	// Whatever closed it (a blur, Dismiss, an action, Escape), the next opening starts fresh.
	if (!open && entered) setEntered(false);
	const keyboardOnly = open && via === "key" && !entered;
	const schedule = (next: boolean, delay: number, kind?: "pointer" | "key") => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => {
			if (kind) setVia(kind);
			// A timer close gets the same cleanup as Escape: focus inside the preview goes back to the row.
			if (next) setOpen(true);
			else changeOpen(false);
		}, delay);
	};
	useEffect(() => () => window.clearTimeout(timer.current), []);
	useEffect(() => {
		if (!entered) return;
		const target = content.current?.querySelector<HTMLElement>("button:not([disabled]), a[href]");
		(target ?? content.current)?.focus();
	}, [entered]);
	const changeOpen = (next: boolean) => {
		if (!next) {
			// A pending open (from a focus a moment ago) must not undo this close.
			window.clearTimeout(timer.current);
			// Escape inside the preview must not drop focus: it goes back to the row.
			if (content.current?.contains(document.activeElement)) {
				ignoreFocusUntil.current = Date.now() + FOCUS_REOPEN_GUARD_MS;
				// The message link, else any other control of the row outside the preview (checkbox, Dismiss).
				const outside = (selector: string) =>
					Array.from(row.current?.querySelectorAll<HTMLElement>(selector) ?? []).find(
						(control) => !content.current?.contains(control),
					);
				(outside("a[href]") ?? outside("button:not([disabled]), input:not([disabled])"))?.focus();
			}
			setEntered(false);
		}
		setOpen(next);
	};

	return (
		<Popover.Root open={open} onOpenChange={changeOpen}>
			<Popover.Anchor asChild>
				<li
					{...rest}
					ref={row}
					data-has-preview
					onPointerEnter={(event) => {
						if (!hoversWith(event.pointerType)) return;
						pointerInside.current = true;
						schedule(true, PREVIEW_OPEN_DELAY_MS, "pointer");
					}}
					onPointerLeave={(event) => {
						if (!hoversWith(event.pointerType)) return;
						pointerInside.current = false;
						schedule(false, PREVIEW_CLOSE_DELAY_MS);
					}}
					onFocus={(event) => {
						// Only keyboard focus: a tap or click that focuses a control must not open it.
						if (Date.now() < ignoreFocusUntil.current) return;
						if (!(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible")) return;
						if (open) return;
						schedule(true, PREVIEW_OPEN_DELAY_MS / 2, "key");
					}}
					onKeyDown={(event) => {
						if (event.key !== "ArrowDown" || !open || !keyboardOnly) return;
						event.preventDefault();
						setEntered(true);
					}}
					onBlur={(event) => {
						const next = event.relatedTarget as Node | null;
						if (next && event.currentTarget.contains(next)) return;
						if (!next && pointerInside.current) return;
						schedule(false, 0);
					}}
				>
					{children}
					<span id={previewHintId(suggestion.id)} className="sr-only">
						{t("Press the down arrow key to reach the preview's buttons.")}
					</span>
					<Popover.Content
						ref={content}
						tabIndex={-1}
						inert={keyboardOnly}
						side="bottom"
						// The end of the row, so the left of the rows below stays free to hover.
						align="end"
						sideOffset={6}
						collisionPadding={8}
						// Focus stays on the row: ArrowDown moves it into the preview (Tab goes row to row) and Escape leaves it.
						onOpenAutoFocus={(event) => event.preventDefault()}
						onCloseAutoFocus={(event) => event.preventDefault()}
						// Tab from the row to its own buttons and into the preview is not leaving it.
						onFocusOutside={(event) => {
							if (event.target instanceof Node && row.current?.contains(event.target)) event.preventDefault();
						}}
						aria-label={t("Suggestion preview")}
						data-suggestion-preview-popover
						className="z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,var(--radix-popover-content-available-width))] overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4 text-start text-neutral-900 shadow-lg focus-visible:outline-none"
					>
						<SuggestionPreviewContent suggestion={suggestion} mailbox={mailbox} onClose={() => changeOpen(false)} />
					</Popover.Content>
				</li>
			</Popover.Anchor>
		</Popover.Root>
	);
}
