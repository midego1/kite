import { getEnv } from "@/lib/cloudflare";
import {
	isUnlocked,
	passwordRequired,
	publicContent,
	publicNotFound,
	publicTooMany,
	resolvePublicLink,
} from "@/lib/drive/public";
import { allowPublicLinkRequest } from "@/lib/drive/rate-limit";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveTokenContext } from "../../../../drive/types";

export const GET = withModule<DriveTokenContext>("drive", async (request, { params, checkHost }) => {
	const env = getEnv();
	if (!(await allowPublicLinkRequest(env, request))) return publicTooMany();
	const { token } = await params;
	const search = new URL(request.url).searchParams;
	const target = await resolvePublicLink(env, token, search.get("item"));
	if (!target || target.item.kind !== "file") return publicNotFound();
	const denied = await checkHost(target.root.ownerId);
	if (denied) return publicNotFound();
	if (!(await isUnlocked(request, target.link))) return passwordRequired();
	return publicContent(env, request, target, search.get("download") === "1");
});
