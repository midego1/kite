"use client";

import { useSyncExternalStore } from "react";

/**
 * A touch (or styluses-only) pointer is the primary or only way to point: `useMessageListHeader`'s "Select"
 * button stays for these, since a row checkbox only reveals on hover, focus or a long press, none of which a
 * finger gets for free.
 */
const TOUCH_QUERY = "(any-pointer: coarse)";

function isTouchDevice(): boolean {
	return window.matchMedia(TOUCH_QUERY).matches;
}

export function useIsTouchDevice(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const media = window.matchMedia(TOUCH_QUERY);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		isTouchDevice,
		() => false,
	);
}
