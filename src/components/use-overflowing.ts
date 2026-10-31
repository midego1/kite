"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Whether the element's content is taller than the element, so it scrolls. Re-measured when the element is
 * resized, when a child is added or removed and when a child changes size, so a list that grows past the
 * viewport (a folder created, a section opened) is noticed without a scroll event. Deeper changes resize a
 * child, so only the direct children are watched.
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
			const children = new Set(Array.from(element.children));
			for (const child of watched) {
				if (children.has(child)) continue;
				watched.delete(child);
				resize.unobserve(child);
			}
			for (const child of children) {
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
		mutations.observe(element, { childList: true });
		measure();
		return () => {
			resize.disconnect();
			mutations.disconnect();
		};
	}, [ref]);

	return overflowing;
}
