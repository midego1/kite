"use client";

import { useCallback, useRef } from "react";

/**
 * Radix returns focus to a dialog's Trigger when it closes. A dialog opened from a shortcut or a button
 * outside its Root has none, so these handlers give focus back to whatever had it when the dialog opened.
 */
export function useReturnFocus() {
	const previous = useRef<HTMLElement | null>(null);
	const onOpenAutoFocus = useCallback(() => {
		// Runs before the dialog moves focus inside, so the active element is still the opener.
		previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}, []);
	const onCloseAutoFocus = useCallback((event: Event) => {
		const opener = previous.current;
		if (!opener?.isConnected) return;
		event.preventDefault();
		opener.focus();
	}, []);
	return { onOpenAutoFocus, onCloseAutoFocus };
}
