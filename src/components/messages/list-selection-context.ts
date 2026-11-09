"use client";

import { createContext, useContext } from "react";

/**
 * How many rows the list beside this reader has checked, provided by `MessageSplitLayout` (which owns that
 * state) so the reader's own single-key shortcuts (`message-shortcuts.ts`) can step aside: with the pane gone,
 * the list and an open message are visible at once, and `e`/`#` must reach the checked rows, not silently
 * archive or trash the one message that happens to be open. Defaults to 0 (no selection) wherever a reader
 * renders without that layout.
 */
export const ListSelectionContext = createContext(0);

export function useListSelectionCount(): number {
	return useContext(ListSelectionContext);
}
