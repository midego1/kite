import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/cloudflare";
import { linkPageState } from "@/lib/drive/public";
import { requirePublicModulePage } from "@/lib/modules/route-guard";
import { PublicDriveExpired } from "./public-drive-states";

export const dynamic = "force-dynamic";

export default async function PublicDriveLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ token: string }>;
}) {
	const state = await linkPageState(getEnv(), (await params).token);
	if (!state) notFound();
	await requirePublicModulePage("drive", { userId: state.ownerId });
	return state.expired ? <PublicDriveExpired /> : children;
}
