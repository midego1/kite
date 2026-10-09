"use client";

import { createPortal } from "react-dom";
import { useHydrated } from "@/hooks/use-hydrated";
import { RouteLoadingBar } from "./route-loading-bar";

// Pinned to the viewport top even when an ancestor's transform (e.g. a page transition) would otherwise become the fixed containing block.
export function RouteLoadingBarPortal() {
	const hydrated = useHydrated();
	if (!hydrated) return <RouteLoadingBar />;
	return createPortal(<RouteLoadingBar />, document.body);
}
