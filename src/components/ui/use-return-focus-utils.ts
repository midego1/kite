/** How recent a press must be to count as the one that opened a dialog. */
const PRESS_WINDOW_MS = 1000;

/** The element a dialog should give focus back to when it closes, or null to leave it to Radix. */
export function pickOpener<T>({
	explicit,
	focused,
	body,
	pressed,
	now,
}: {
	explicit: T | null;
	focused: T | null;
	body: T;
	pressed: { element: T; at: number } | null;
	now: number;
}): T | null {
	if (explicit) return explicit;
	if (focused && focused !== body) return focused;
	if (pressed && now - pressed.at <= PRESS_WINDOW_MS) return pressed.element;
	return null;
}
