import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { detectDraft } from "@/lib/finance/draft";
import { readJson, respond } from "@/lib/finance/route-answer";
import { withModule } from "@/lib/modules/route-guard";

export const POST = withModule("finance", async (request, { checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	return respond(await detectDraft(user, await readJson(request)));
});
