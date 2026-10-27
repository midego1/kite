"use client";

import { createContext, useContext } from "react";

/** Set by the reader: replies started inside it dock under its open message instead of floating. */
export const InlineComposerHostContext = createContext<{ messageId: string } | null>(null);

export function useInlineComposerHost() {
	return useContext(InlineComposerHostContext);
}
