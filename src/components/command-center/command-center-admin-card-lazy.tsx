"use client";

import dynamic from "next/dynamic";

/**
 * The admin card and the admin overview's queries it needs load only for admins, on first show. The inline
 * `typeof window` check is what lets the server build drop the chunk; a helper around `import()` would not.
 */
export const LazyCommandCenterAdminCard = dynamic(
	() =>
		(typeof window === "undefined" ? new Promise<never>(() => {}) : import("./command-center-admin-card")).then(
			(module) => module.CommandCenterAdminCard,
		),
	{ ssr: false },
);
