"use client";

import dynamic from "next/dynamic";

/** Starts downloading the composer ahead of the first open. */
export function preloadComposeForm() {
	return import("./compose-form");
}

export const LazyComposeForm = dynamic(() => preloadComposeForm().then((module) => module.ComposeForm), { ssr: false });
