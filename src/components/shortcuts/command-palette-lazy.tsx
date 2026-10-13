"use client";

import dynamic from "next/dynamic";

/**
 * The palette dialog loads on first open. The inline `typeof window` check is what lets the server
 * build drop the chunk; a helper around `import()` would not.
 */
export const LazyCommandPalette = dynamic(
	() =>
		(typeof window === "undefined" ? new Promise<never>(() => {}) : import("./command-palette")).then(
			(module) => module.CommandPalette,
		),
	{ ssr: false },
);
