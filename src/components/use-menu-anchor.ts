"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { menuAnchorAbove } from "./mailbox-selector-utils";

/**
 * Where a menu that opens upward from `ref` goes. `measure` takes the position (call it when the menu opens), and
 * while `open` the window's size changes measure again, so the menu follows its button and keeps fitting.
 */
export function useMenuAnchor(open: boolean, ref: RefObject<HTMLElement | null>) {
	const [anchor, setAnchor] = useState<ReturnType<typeof menuAnchorAbove>>(null);
	const measure = useCallback(() => setAnchor(menuAnchorAbove(ref.current)), [ref]);
	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open, measure]);
	return { anchor, measure };
}
