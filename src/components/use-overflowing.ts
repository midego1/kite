"use client";

import { useEffect, useState, type RefObject } from "react";

export type OverflowEdges = {
	/** Content is hidden above the top edge (the element is scrolled down). */
	above: boolean;
	/** Content is hidden below the bottom edge (there is more to scroll to). */
	below: boolean;
};

const NONE: OverflowEdges = { above: false, below: false };

/**
 * On which edges the element hides content that scrolls into view: re-measured on scroll, when the element is
 * resized, when a child is added or removed and when a child changes size, so a list that grows past the
 * viewport (a folder created, a section opened) is noticed without a scroll event. Deeper changes resize a
 * child, so only the direct children are watched.
 */
export function useOverflowEdges(ref: RefObject<HTMLElement | null>): OverflowEdges {
	const [edges, setEdges] = useState<OverflowEdges>(NONE);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const hidden = element.scrollHeight - element.clientHeight;
			const next = { above: element.scrollTop > 1, below: hidden > 1 && element.scrollTop < hidden - 1 };
			setEdges((current) => (current.above === next.above && current.below === next.below ? current : next));
		};
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
		element.addEventListener("scroll", measure, { passive: true });
		measure();
		return () => {
			resize.disconnect();
			mutations.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [ref]);

	return edges;
}
