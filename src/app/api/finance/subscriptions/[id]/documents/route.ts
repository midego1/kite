import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { addDocument } from "@/lib/finance/manual-documents";
import { readJson, respond } from "@/lib/finance/route-answer";
import { withModule } from "@/lib/modules/route-guard";
import type { SubscriptionRouteContext } from "../types";

export const POST = withModule<SubscriptionRouteContext>("finance", async (request, { params, checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const { id } = await params;
	return respond(await addDocument(user, id, await readJson(request)));
});
