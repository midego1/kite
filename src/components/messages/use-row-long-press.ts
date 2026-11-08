"use client";

import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { LONG_PRESS_MS, shouldCancelLongPress } from "./use-row-long-press-utils";

/**
 * A touch long press on a row: holding a finger still for `LONG_PRESS_MS` calls `onLongPress` instead of letting
 * the row open, the way a "Select" button does for a pointer that cannot hover.
 */
export function useRowLongPress(onLongPress: () => void) {
	const start = useRef<{ x: number; y: number } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Set once the press fires, so the click it is about to release does not also open the row; a capturing
	// click handler on the same element clears it after swallowing that one click.
	const fired = useRef(false);

	function clear() {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		start.current = null;
	}

	return {
		onPointerDown(event: ReactPointerEvent) {
			if (event.pointerType !== "touch") return;
			start.current = { x: event.clientX, y: event.clientY };
			timer.current = setTimeout(() => {
				fired.current = true;
				clear();
				onLongPress();
			}, LONG_PRESS_MS);
		},
		onPointerMove(event: ReactPointerEvent) {
			if (start.current && shouldCancelLongPress(start.current, { x: event.clientX, y: event.clientY })) clear();
		},
		onPointerUp: clear,
		onPointerCancel: clear,
		onClickCapture(event: ReactMouseEvent) {
			if (!fired.current) return;
			fired.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
	};
}
