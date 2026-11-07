import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { patchPayment, removePayment } from "@/lib/finance/manual-payments";
import { readJson, respond } from "@/lib/finance/route-answer";
import { withModule } from "@/lib/modules/route-guard";
import type { PaymentRouteContext } from "./types";

export const PATCH = withModule<PaymentRouteContext>("finance", async (request, { params, checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const { id } = await params;
	return respond(await patchPayment(user, id, await readJson(request)));
});

export const DELETE = withModule<PaymentRouteContext>("finance", async (request, { params, checkUser }) => {
	const { user, error } = await requireSessionUser(getEnv(), request);
	if (error) return error;
	const denied = await checkUser(user);
	if (denied) return denied;
	const { id } = await params;
	return respond(await removePayment(user, id));
});
