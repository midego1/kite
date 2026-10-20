"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useBranding } from "@/components/branding-provider";
import { formatRouteTitle, getRouteTitle } from "./route-title-utils";

/** Names the tab after the page, so the route announcer reads the right page after a client-side navigation. */
export function RouteTitle() {
	const pathname = usePathname();
	const { appName } = useBranding();
	const pageTitle = getRouteTitle(pathname);
	const title = pageTitle ? formatRouteTitle(pageTitle, appName) : null;

	useEffect(() => {
		if (title) document.title = title;
	}, [title]);

	return null;
}
