"use client";

import dynamic from "next/dynamic";

/** Starts downloading the assistant ahead of the first open, e.g. on hover of its button. */
export function preloadAgentPanel() {
	return import("./agent-panel");
}

export const LazyAgentPanel = dynamic(() => preloadAgentPanel().then((module) => module.AgentPanel), { ssr: false });
