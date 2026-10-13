"use client";

import dynamic from "next/dynamic";

/**
 * Starts downloading the assistant ahead of the first open, e.g. on hover of its button. The inline
 * `typeof window` check is what lets the server build drop the chunk; a helper around `import()` would not.
 */
export function preloadAgentPanel() {
	return typeof window === "undefined" ? new Promise<never>(() => {}) : import("./agent-panel");
}

export const LazyAgentPanel = dynamic(() => preloadAgentPanel().then((module) => module.AgentPanel), { ssr: false });
