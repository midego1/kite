/** How long a still finger must hold a row before it counts as a long press, not a tap. */
export const LONG_PRESS_MS = 500;
/** Finger movement past this many pixels cancels the press: a scroll or a swipe, not a hold. */
const MOVE_TOLERANCE = 10;

export function shouldCancelLongPress(start: { x: number; y: number }, point: { x: number; y: number }): boolean {
	return Math.abs(point.x - start.x) > MOVE_TOLERANCE || Math.abs(point.y - start.y) > MOVE_TOLERANCE;
}
