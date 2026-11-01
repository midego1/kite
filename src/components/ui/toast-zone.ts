"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Where the open composer sits, so the toasts and send bars can keep clear of it: `docked` is the floating window
 * in the bottom-right corner, `docked-aside` the same one moved left of the open assistant window, `modal` the expanded one in the middle of the screen, `page` the Compose page.
 * globals.css moves `--kite-toast-*` per zone; the attribute lives on <html>.
 */
export type ComposerZone = "docked" | "docked-aside" | "modal" | "page";

const ZONE_ATTRIBUTE = "data-composer";
/** Below this width a docked composer leaves no room beside it, so toasts move to the top of the screen. */
const NARROW_QUERY = "(max-width: 1023px)";

function readZone(): ComposerZone | null {
	return (document.documentElement.getAttribute(ZONE_ATTRIBUTE) as ComposerZone | null) ?? null;
}

/** Every open composer by owner: the page composer and a floating one can be open together, and the newest counts. */
const openZones = new Map<symbol, ComposerZone>();

function publishZone() {
	const newest = [...openZones.values()].pop();
	if (newest) document.documentElement.setAttribute(ZONE_ATTRIBUTE, newest);
	else document.documentElement.removeAttribute(ZONE_ATTRIBUTE);
}

/** Marks a composer as open for as long as the calling component stays mounted in `zone`. */
export function useComposerZone(zone: ComposerZone | null) {
	const [owner] = useState(() => Symbol("composer"));
	useEffect(() => {
		if (!zone) return;
		openZones.set(owner, zone);
		publishZone();
		return () => {
			openZones.delete(owner);
			publishZone();
		};
	}, [owner, zone]);
}

function subscribe(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: [ZONE_ATTRIBUTE] });
	const media = window.matchMedia(NARROW_QUERY);
	media.addEventListener("change", onChange);
	return () => {
		observer.disconnect();
		media.removeEventListener("change", onChange);
	};
}

function toastsAtTop() {
	const zone = readZone();
	return zone === "docked-aside" || (zone === "docked" && window.matchMedia(NARROW_QUERY).matches);
}

/** True while the docked composer leaves no room beside it (a narrow screen, or the assistant window next to it), so toasts go to the top instead. */
export function useToastsAtTop() {
	return useSyncExternalStore(subscribe, toastsAtTop, () => false);
}
