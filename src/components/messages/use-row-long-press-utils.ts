import { TOUCH_GESTURE_INTENT_DISTANCE } from "./touch-gesture-thresholds";

/** How long a still finger must hold a row before it counts as a long press, not a tap. */
export const LONG_PRESS_MS = 500;

export function shouldCancelLongPress(start: { x: number; y: number }, point: { x: number; y: number }): boolean {
	return (
		Math.abs(point.x - start.x) > TOUCH_GESTURE_INTENT_DISTANCE ||
		Math.abs(point.y - start.y) > TOUCH_GESTURE_INTENT_DISTANCE
	);
}
