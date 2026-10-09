"use client";

import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** Keep newly loaded draft previews in view, without moving someone reading earlier messages. */
export function useChatContentResize(
	containerRef: RefObject<HTMLDivElement | null>,
	stickToBottomRef: RefObject<boolean>,
	active: boolean,
) {
	useLayoutEffect(() => {
		if (!active) return;
		const container = containerRef.current;
		const content = container?.firstElementChild;
		if (!container || !content) return;
		const observer = new ResizeObserver(() => {
			if (stickToBottomRef.current) container.scrollTop = container.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [active, containerRef, stickToBottomRef]);
}
