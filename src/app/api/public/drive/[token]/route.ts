import { getEnv } from "@/lib/cloudflare";
import {
	isUnlocked,
	passwordRequired,
	publicJson,
	publicMetadata,
	publicNotFound,
	publicTooMany,
	resolvePublicLink,
} from "@/lib/drive/public";
import { allowPublicLinkRequest } from "@/lib/drive/rate-limit";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveTokenContext } from "../../../drive/types";

export const GET = withModule<DriveTokenContext>("drive", async (request, { params, checkHost }) => {
	const env = getEnv();
	if (!(await allowPublicLinkRequest(env, request))) return publicTooMany();
	const { token } = await params;
	const target = await resolvePublicLink(env, token, new URL(request.url).searchParams.get("item"));
	if (!target) return publicNotFound();
	const denied = await checkHost(target.root.ownerId);
	if (denied) return publicNotFound();
	if (!(await isUnlocked(request, target.link))) return passwordRequired();
	return publicJson(await publicMetadata(env, target));
});
