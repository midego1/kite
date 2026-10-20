import { getEnv } from "@/lib/cloudflare";
import { appOrigin, readJson } from "@/lib/drive/auth";
import { unlockCookieHeader } from "@/lib/drive/link-utils";
import { publicJson, publicNotFound, publicTooMany, resolvePublicLink, unlockLink } from "@/lib/drive/public";
import { allowLinkUnlockAttempt, allowPublicLinkRequest } from "@/lib/drive/rate-limit";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveTokenContext } from "../../../../drive/types";

export const POST = withModule<DriveTokenContext>("drive", async (request, { params, checkHost }) => {
	const env = getEnv();
	if (!(await allowPublicLinkRequest(env, request))) return publicTooMany();
	const { token } = await params;
	const target = await resolvePublicLink(env, token, null);
	if (!target || !target.link.passwordHash) return publicNotFound();
	const denied = await checkHost(target.root.ownerId);
	if (denied) return publicNotFound();
	if (!(await allowLinkUnlockAttempt(env, request, target.link.id))) return publicTooMany();
	const password = ((await readJson(request)) as { password?: unknown } | null)?.password;
	const unlock = await unlockLink(target.link, password);
	if (!unlock) return publicJson({ error: "Wrong password" }, 401);
	const secure = new URL(request.url).protocol === "https:" || appOrigin(env, request).startsWith("https:");
	return publicJson({ ok: true }, 200, { "Set-Cookie": unlockCookieHeader(target.link.id, token, unlock, secure) });
});
