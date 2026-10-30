"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Whether the element's content is taller than the element, so it scrolls. Re-measured when the element is
 * resized, when its content is added or removed and when a child changes size, so a list that grows past the
 * viewport (a folder created, a section opened) is noticed without a scroll event.
 */
export function useOverflowing(ref: RefObject<HTMLElement | null>): boolean {
	const [overflowing, setOverflowing] = useState(false);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
		const resize = new ResizeObserver(measure);
		const watched = new Set<Element>();
		const watchChildren = () => {
			for (const child of Array.from(element.children)) {
				if (watched.has(child)) continue;
				watched.add(child);
				resize.observe(child);
			}
		};
		const mutations = new MutationObserver(() => {
			watchChildren();
			measure();
		});
		resize.observe(element);
		watchChildren();
		mutations.observe(element, { childList: true, subtree: true });
		measure();
		return () => {
			resize.disconnect();
			mutations.disconnect();
		};
	}, [ref]);

	return overflowing;
}
