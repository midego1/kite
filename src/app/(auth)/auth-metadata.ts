import type { Metadata } from "next";
import { getHomeBranding } from "@/app/home-server-utils";
import { formatRouteTitle } from "@/components/route-title-utils";

export async function authPageMetadata(pageTitle: string): Promise<Metadata> {
	const { appName } = await getHomeBranding();
	return { title: formatRouteTitle(pageTitle, appName) };
}
