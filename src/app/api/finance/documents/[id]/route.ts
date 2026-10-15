import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { removeDocument } from "@/lib/finance/manual-documents";
import { respond } from "@/lib/finance/route-answer";
import { withModule } from "@/lib/modules/route-guard";
import type { DocumentRouteContext } from "./types";

export const DELETE = withModule<DocumentRouteContext>("finance", async (request, { params, checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const { id } = await params;
	return respond(await removeDocument(user, id));
});
