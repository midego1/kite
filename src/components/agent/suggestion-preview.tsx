"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { OpenSuggestion } from "@/hooks/open-suggestions-types";
import { hoversWith, PREVIEW_CLOSE_DELAY_MS, PREVIEW_OPEN_DELAY_MS } from "./suggestion-preview-utils";

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
 * too (and Tab then reaches its buttons, since it follows the row in the page), Escape closes it, and it stays
 * open while the pointer is in the row or the preview. A finger has no hover, so on touch nothing opens and the
 * row keeps opening the message. The details are only requested when it opens.
 */
export function SuggestionPreviewRow({
	suggestion,
	mailbox = null,
	children,
	...rest
}: { suggestion: OpenSuggestion; mailbox?: string | null } & HTMLAttributes<HTMLLIElement>) {
	const [open, setOpen] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	const row = useRef<HTMLLIElement>(null);
	const schedule = (next: boolean, delay: number) => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOpen(next), delay);
	};
	useEffect(() => () => window.clearTimeout(timer.current), []);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Anchor asChild>
				<li
					{...rest}
					ref={row}
					data-has-preview
					onPointerEnter={(event) => {
						if (hoversWith(event.pointerType)) schedule(true, PREVIEW_OPEN_DELAY_MS);
					}}
					onPointerLeave={(event) => {
						if (hoversWith(event.pointerType)) schedule(false, PREVIEW_CLOSE_DELAY_MS);
					}}
					onFocus={(event) => {
						// Only keyboard focus: a tap or click that focuses a control must not open it.
						if (event.target instanceof HTMLElement && event.target.matches(":focus-visible"))
							schedule(true, PREVIEW_OPEN_DELAY_MS / 2);
					}}
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) schedule(false, 0);
					}}
				>
					{children}
					<Popover.Content
						side="bottom"
						// The end of the row, so the left of the rows below stays free to hover.
						align="end"
						sideOffset={6}
						collisionPadding={8}
						// Focus stays on the row: the preview is reached with Tab and left with Escape.
						onOpenAutoFocus={(event) => event.preventDefault()}
						onCloseAutoFocus={(event) => event.preventDefault()}
						// Tab from the row to its own buttons and into the preview is not leaving it.
						onFocusOutside={(event) => {
							if (event.target instanceof Node && row.current?.contains(event.target)) event.preventDefault();
						}}
						aria-label="Suggestion preview"
						data-suggestion-preview-popover
						className="z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(26rem,var(--radix-popover-content-available-width))] overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4 text-start text-neutral-900 shadow-lg focus-visible:outline-none"
					>
						<SuggestionPreviewContent suggestion={suggestion} mailbox={mailbox} onClose={() => setOpen(false)} />
					</Popover.Content>
				</li>
			</Popover.Anchor>
		</Popover.Root>
	);
}
