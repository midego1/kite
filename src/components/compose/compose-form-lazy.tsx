"use client";

import dynamic from "next/dynamic";

/**
 * Starts downloading the composer ahead of the first open. The inline `typeof window` check is what
 * lets the server build drop the chunk; a helper around `import()` would not.
 */
export function preloadComposeForm() {
	return typeof window === "undefined" ? new Promise<never>(() => {}) : import("./compose-form");
}

export const LazyComposeForm = dynamic(() => preloadComposeForm().then((module) => module.ComposeForm), { ssr: false });
