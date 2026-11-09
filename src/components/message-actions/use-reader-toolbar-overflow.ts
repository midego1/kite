"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { packToolbarActions, type OverflowItem } from "@/components/messages/bulk-toolbar-overflow-utils";

/** Marks the header's flexible spacer, whose width is the room the reader toolbar could still grow into. */
export const READER_TOOLBAR_SPACER_ATTR = "data-reader-toolbar-spacer";
/** On an action wrapper: measured, and moved into "More actions" when it does not fit. */
export const OVERFLOW_ID_ATTR = "data-overflow-id";
/** On a wrapper that must always show (More actions, Delete): its width is set aside before packing. */
export const OVERFLOW_FIXED_ATTR = "data-overflow-fixed";

/**
 * The error text's width at its natural size, capped at its own max-width. Its current box is the wrong figure: when
 * the row is full the error is the one shrinkable child and absorbs the overflow, so measuring it squeezed would
 * reserve a sliver, leave every action inline and collapse the message to an ellipsis.
 */
function naturalLeadWidth(lead: HTMLElement) {
	const maxWidth = parseFloat(getComputedStyle(lead).maxWidth);
	return Number.isFinite(maxWidth) ? Math.min(lead.scrollWidth, maxWidth) : lead.scrollWidth;
}

/**
 * Which of `ids`, in priority order, the reader toolbar has room to show inline, measured against the header it
 * sits in rather than a breakpoint: a 360px phone and a window with a wide list beside the reader are both
 * "narrow" here when the row would not fit. The rest move into "More actions", so the row never wraps and never
 * pushes More or Delete out of the header.
 *
 * `rootRef` goes on the toolbar's flex row. Every action wrapper carries `data-overflow-id`, and what must stay
 * (More, Delete) `data-overflow-fixed`. An action that has overflowed stays rendered, `invisible absolute`, so its
 * natural width can still be measured; `invisible` also keeps it out of the tab order and the accessibility tree.
 * The room is the row's own width plus the header's spacer: the row grows by exactly what the spacer gives up,
 * so the figure does not depend on which actions are showing. On a phone the row fills the header itself and
 * there is no spacer. `measureKey` should change whenever an action's label (so its width) can change.
 */
export function useReaderToolbarOverflow(ids: string[], measureKey: string) {
	const rootRef = useRef<HTMLDivElement>(null);
	// Optimistic until the first measurement (a layout effect, so it resolves before paint).
	const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set(ids));

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const spacer = root.parentElement?.querySelector<HTMLElement>(`:scope > [${READER_TOOLBAR_SPACER_ATTR}]`) ?? null;

		function recompute() {
			const row = root!;
			const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
			const available = row.getBoundingClientRect().width + (spacer ? spacer.getBoundingClientRect().width : 0);
			const fixed = [...row.querySelectorAll<HTMLElement>(`[${OVERFLOW_FIXED_ATTR}]`)];
			const lead = row.querySelector<HTMLElement>("[data-overflow-lead]");
			// A gap sits between the last action and the first fixed item, and between the fixed items.
			const reserved =
				fixed.reduce((sum, el) => sum + el.getBoundingClientRect().width + gap, 0) +
				(lead ? naturalLeadWidth(lead) + gap : 0);
			const items: OverflowItem[] = ids.map((id) => {
				const el = row.querySelector<HTMLElement>(`[${OVERFLOW_ID_ATTR}="${id}"]`);
				return { id, width: el ? el.getBoundingClientRect().width : 0 };
			});
			// An action too wide for what is left (Reply all, with its label) must not hide the icon-only ones after it.
			const next = packToolbarActions(available, reserved, gap, items, { skipOversized: true });
			setVisibleIds((current) =>
				current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
			);
		}

		recompute();
		const observer = new ResizeObserver(recompute);
		observer.observe(root);
		if (spacer) observer.observe(spacer);
		// A web font that finishes loading after mount changes every label's width without resizing anything.
		let cancelled = false;
		void document.fonts?.ready.then(() => {
			if (!cancelled) recompute();
		});
		return () => {
			cancelled = true;
			observer.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `measureKey` stands in for `ids` and every label.
	}, [measureKey]);

	return { rootRef, visibleIds };
}
