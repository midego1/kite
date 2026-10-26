"use client";

import { useCallback, useRef } from "react";
import { pickOpener } from "./use-return-focus-utils";

// Safari and iOS do not focus a button when it is clicked, so the element focused when a dialog opens can
// be <body>. The last button or link pressed stands in for it.
let lastPressed: { element: HTMLElement; at: number } | null = null;
if (typeof document !== "undefined") {
	document.addEventListener(
		"pointerdown",
		(event) => {
			const element = event.target instanceof Element ? event.target.closest<HTMLElement>("button, a[href]") : null;
			if (element) lastPressed = { element, at: Date.now() };
		},
		true,
	);
}

/**
 * Radix returns focus to a dialog's Trigger when it closes. A dialog opened from a shortcut or a button
 * outside its Root has none, so these handlers give focus back to its opener: `getOpener` when given, else
 * the element that had focus, else the button pressed just before.
 */
export function useReturnFocus(getOpener?: () => HTMLElement | null) {
	const previous = useRef<HTMLElement | null>(null);
	const onOpenAutoFocus = useCallback(() => {
		// Runs before the dialog moves focus inside, so the active element is still the opener.
		previous.current = pickOpener({
			explicit: getOpener?.() ?? null,
			focused: document.activeElement instanceof HTMLElement ? document.activeElement : null,
			body: document.body,
			pressed: lastPressed,
			now: Date.now(),
		});
	}, [getOpener]);
	const onCloseAutoFocus = useCallback((event: Event) => {
		const opener = previous.current;
		if (!opener?.isConnected) return;
		event.preventDefault();
		opener.focus();
	}, []);
	return { onOpenAutoFocus, onCloseAutoFocus };
}
