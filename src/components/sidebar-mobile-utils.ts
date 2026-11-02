"use client";

import { useSyncExternalStore } from "react";
import { PHONE_SHELL_VIEWPORT_QUERY } from "./fold-posture-utils";

const mobileQuery = PHONE_SHELL_VIEWPORT_QUERY;

export function isMobileViewport(): boolean {
	return window.matchMedia(mobileQuery).matches;
}

export function useIsMobile(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const media = window.matchMedia(mobileQuery);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		isMobileViewport,
		() => false,
	);
}
