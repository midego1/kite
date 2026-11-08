"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { packToolbarActions, TOOLBAR_GAP_PX, type OverflowItem } from "./bulk-toolbar-overflow-utils";

/** Extra gap reserved around the row's collapsing spacer, which sits between the packed actions and the tail
 * cluster and is not itself measured: better to show one action fewer at the exact boundary than to clip one. */
const SAFETY_GAP_PX = TOOLBAR_GAP_PX * 3;

/**
 * Which of `ids`, in priority order, the bulk toolbar has room to show inline, measured against the list
 * header's own current width rather than a fixed breakpoint: a 360px split-pane list and a 700px window are
 * both "narrow" here if the fully labelled row would not fit, and a wide one is not, whatever the browser
 * window around it measures. Everything that does not fit moves into "More actions" instead of being clipped
 * by the panel's own `overflow-hidden`.
 *
 * Four refs wire this up: `containerRef` on the real, visible row (observed for its width); `headRef` and
 * `tailRef` on the two always-rendered ends of that row (the selected count at the start, Clear selection at
 * the end), whose current widths are read directly, live; and `measureRef` on a hidden, full-width clone of
 * every action in `ids` plus a `"__more__"` stand-in for the More actions trigger (`data-overflow-id` on
 * each), used only to read natural, unclipped widths that never depend on which ones end up visible.
 * `measureKey` should change whenever an action's label text (so its width) can change — the selected count,
 * read/unread wording, the folder's action set — since the ids alone do not capture that.
 */
export function useBulkToolbarOverflow(ids: string[], measureKey: string) {
	const containerRef = useRef<HTMLDivElement>(null);
	const headRef = useRef<HTMLDivElement>(null);
	const tailRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	// Optimistic until the first measurement (a layout effect, so it resolves before paint): everything fits
	// rather than everything overflowing, since most toolbars most of the time do have the room.
	const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set(ids));

	useLayoutEffect(() => {
		const container = containerRef.current;
		const measure = measureRef.current;
		if (!container || !measure) return;

		function recompute() {
			const availableWidth = container!.clientWidth;
			const headWidth = headRef.current?.getBoundingClientRect().width ?? 0;
			const tailWidth = tailRef.current?.getBoundingClientRect().width ?? 0;
			const moreEl = measure!.querySelector<HTMLElement>('[data-overflow-id="__more__"]');
			// Reserved whether or not "More actions" ends up rendered: showing it only when something has
			// actually overflowed must never let that same decision change how much room it had to begin with.
			const moreWidth = moreEl ? moreEl.getBoundingClientRect().width : 0;
			const reservedWidth = headWidth + tailWidth + (moreWidth > 0 ? moreWidth + TOOLBAR_GAP_PX : 0) + SAFETY_GAP_PX;
			const items: OverflowItem[] = ids.map((id) => {
				const el = measure!.querySelector<HTMLElement>(`[data-overflow-id="${id}"]`);
				return { id, width: el ? el.getBoundingClientRect().width : 0 };
			});
			setVisibleIds(packToolbarActions(availableWidth, reservedWidth, TOOLBAR_GAP_PX, items));
		}

		recompute();
		const observer = new ResizeObserver(recompute);
		observer.observe(container);
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `measureKey` stands in for `ids` and every label.
	}, [measureKey]);

	return { containerRef, headRef, tailRef, measureRef, visibleIds };
}
