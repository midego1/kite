"use client";

import { useRef } from "react";
import type { PointerEvent } from "react";
import { toInlineDelta } from "@/components/interface-direction-utils";
import type { ResizeHandleProps } from "./resize-handle-types";

/** `onResize` gets the distance from the drag's start: downward, or along the reading direction for a vertical handle. */
export function ResizeHandle({
	label,
	orientation = "vertical",
	onResizeStart,
	onResize,
	onResizeEnd,
}: ResizeHandleProps) {
	const start = useRef<number | null>(null);
	const horizontal = orientation === "horizontal";

	function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		start.current = horizontal ? event.clientY : event.clientX;
		event.currentTarget.setPointerCapture(event.pointerId);
		onResizeStart?.();
		event.preventDefault();
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
		if (start.current === null) return;
		onResize(horizontal ? event.clientY - start.current : toInlineDelta(event.clientX - start.current));
	}

	function handlePointerEnd() {
		if (start.current === null) return;
		start.current = null;
		onResizeEnd?.();
	}

	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation={orientation}
			className={
				horizontal
					? "absolute inset-x-0 bottom-0 z-20 h-2 translate-y-1/2 cursor-row-resize touch-none"
					: "absolute inset-y-0 end-0 z-20 w-2 translate-x-1/2 cursor-col-resize touch-none rtl:-translate-x-1/2"
			}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerEnd}
			onPointerCancel={handlePointerEnd}
		/>
	);
}
