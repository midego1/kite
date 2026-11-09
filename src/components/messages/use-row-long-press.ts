"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { LONG_PRESS_MS, shouldCancelLongPress } from "./use-row-long-press-utils";

/**
 * A touch long press on a row: holding a finger still for `LONG_PRESS_MS` calls `onLongPress` instead of letting
 * the row open, the way a "Select" button does for a pointer that cannot hover. `cancel` lets a sibling gesture
 * (the row's own swipe-to-archive, `SwipeableRow`'s `onDragStart`) stop the pending press once it captures the
 * pointer, since none of this hook's own handlers see a captured pointer's later move or up events again.
 */
export function useRowLongPress(onLongPress: () => void) {
	const start = useRef<{ x: number; y: number } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The one finger a press is tracked for; a second finger touching the same row does not start a second timer.
	const pointerId = useRef<number | null>(null);
	// Set once the press fires, so the click it is about to release does not also open the row; a capturing
	// click handler on the same element clears it after swallowing that one click. Also cleared at the start of
	// the next press, so a long press with nothing clicked after it (a scroll away, say) never swallows a later tap.
	const fired = useRef(false);

	function clear() {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		start.current = null;
		pointerId.current = null;
	}

	// A row can leave the list (filtered out, deleted, archived) while its press is still pending.
	useEffect(() => clear, []);

	return {
		cancel: clear,
		handlers: {
			onPointerDown(event: ReactPointerEvent) {
				if (event.pointerType !== "touch" || pointerId.current !== null) return;
				fired.current = false;
				pointerId.current = event.pointerId;
				start.current = { x: event.clientX, y: event.clientY };
				timer.current = setTimeout(() => {
					fired.current = true;
					clear();
					onLongPress();
				}, LONG_PRESS_MS);
			},
			onPointerMove(event: ReactPointerEvent) {
				if (pointerId.current !== event.pointerId || !start.current) return;
				if (shouldCancelLongPress(start.current, { x: event.clientX, y: event.clientY })) clear();
			},
			onPointerUp(event: ReactPointerEvent) {
				if (pointerId.current === event.pointerId) clear();
			},
			onPointerCancel(event: ReactPointerEvent) {
				if (pointerId.current === event.pointerId) clear();
			},
			onClickCapture(event: ReactMouseEvent) {
				if (!fired.current) return;
				fired.current = false;
				event.preventDefault();
				event.stopPropagation();
			},
		},
	};
}
