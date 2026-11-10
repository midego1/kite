/**
 * Finger movement past this many pixels, in either axis, is a scroll or a swipe starting, not a still hold or an
 * accidental wobble. Shared by `SwipeableRow` (which commits to a horizontal drag past it) and `useRowLongPress`
 * (which cancels past it), so a real swipe reliably cancels a long press before the row commits to dragging,
 * and the two gestures can never disagree about where a "still finger" ends.
 */
export const TOUCH_GESTURE_INTENT_DISTANCE = 10;
