"use client";

import clsx from "clsx";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { toInlineDelta } from "@/components/interface-direction-utils";
import { TOUCH_GESTURE_INTENT_DISTANCE } from "./touch-gesture-thresholds";

type SwipeAction = {
	label: string;
	icon: LucideIcon;
	className: string;
	onTrigger: () => void;
};

type SwipeableRowProps = {
	children: ReactNode;
	// Revealed when dragging left to right.
	startAction: SwipeAction;
	// Revealed when dragging right to left.
	endAction: SwipeAction;
	disabled?: boolean;
	role?: string;
	/**
	 * Called once the drag captures the pointer, so a sibling gesture (the row's own long press) can cancel
	 * itself: a captured pointer's later move and up events are retargeted to this element, so they never reach
	 * a handler on a child of it again.
	 */
	onDragStart?: () => void;
};

const COMMIT_DISTANCE = 88;
const INTENT_DISTANCE = TOUCH_GESTURE_INTENT_DISTANCE;

// Touch-only swipe gestures; vertical scrolling stays with the browser via touch-action: pan-y.
export function SwipeableRow({ children, startAction, endAction, disabled, role, onDragStart }: SwipeableRowProps) {
	const [offset, setOffset] = useState(0);
	const [dragging, setDragging] = useState(false);
	const gesture = useRef<{ x: number; y: number; active: boolean; id: number } | null>(null);
	const swiped = useRef(false);

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (disabled || event.pointerType === "mouse") return;
		gesture.current = { x: event.clientX, y: event.clientY, active: false, id: event.pointerId };
		swiped.current = false;
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.active) {
			if (Math.abs(dy) > INTENT_DISTANCE && Math.abs(dy) > Math.abs(dx)) {
				gesture.current = null;
				return;
			}
			if (Math.abs(dx) < INTENT_DISTANCE) return;
			current.active = true;
			setDragging(true);
			event.currentTarget.setPointerCapture(event.pointerId);
			onDragStart?.();
		}
		setOffset(dx);
	}

	function finish(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		gesture.current = null;
		if (!current.active) return;
		swiped.current = true;
		setDragging(false);
		const distance = toInlineDelta(event.clientX - current.x);
		setOffset(0);
		if (event.type !== "pointercancel") {
			if (distance >= COMMIT_DISTANCE) startAction.onTrigger();
			else if (distance <= -COMMIT_DISTANCE) endAction.onTrigger();
		}
	}

	// A row pulled away from the start of the line (rightward, or leftward when mirrored) shows the start action there.
	const fromStart = toInlineDelta(offset) > 0;
	const action = offset === 0 ? null : fromStart ? startAction : endAction;
	const Icon = action?.icon;
	const armed = Math.abs(offset) >= COMMIT_DISTANCE;

	return (
		<div role={role} className="relative overflow-hidden">
			{action && Icon && (
				<div
					aria-hidden="true"
					className={clsx(
						"absolute inset-0 flex items-center px-6 text-white",
						fromStart ? "justify-start" : "justify-end",
						action.className,
					)}
				>
					<span
						className={clsx("flex items-center gap-2 text-sm font-medium transition-transform", armed && "scale-110")}
					>
						<Icon className="h-5 w-5" />
						{action.label}
					</span>
				</div>
			)}
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={finish}
				onClickCapture={(event) => {
					if (!swiped.current) return;
					swiped.current = false;
					event.preventDefault();
					event.stopPropagation();
				}}
				className={clsx(
					"relative bg-white",
					!dragging && "transition-transform duration-200 ease-out motion-reduce:transition-none",
				)}
				style={{ transform: offset ? `translateX(${offset}px)` : undefined, touchAction: "pan-y" }}
			>
				{children}
			</div>
		</div>
	);
}
