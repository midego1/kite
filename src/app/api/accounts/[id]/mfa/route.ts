import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { recordAuthActivity } from "@/lib/auth/activity";
import { resetUserSecondFactors } from "@/lib/auth/mfa";
import { requireAccountAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { selectAccountById } from "../utils";

/**
 * Resets an account's second factors (TOTP, recovery codes, passkeys) and signs it out everywhere, for someone
 * locked out of their devices. The same rules as editing the account: admins without the primary role only for
 * plain users.
 */
export async function DELETE(request: Request, { params }: AccountRouteParams) {
	const access = await requireAccountAdmin(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	const actor = access.user!;
	const actorIsPrimary = isPrimaryAdmin(actor);
	if (!actorIsPrimary && !canManageUsers(actor)) {
		return NextResponse.json({ error: "You do not have permission to manage users" }, { status: 403 });
	}
	if (!actorIsPrimary && (account.role === "admin" || account.isPrimaryAdmin)) {
		return NextResponse.json({ error: "Only the primary admin can manage admin accounts" }, { status: 403 });
	}
	const { passkeysRemoved } = await resetUserSecondFactors(access.env, id);
	await recordAuthActivity(access.env, {
		action: "auth.mfa_reset",
		userId: id,
		actorUserId: actor.id,
		request,
		details: { passkeysRemoved },
	});
	return NextResponse.json({ ok: true, passkeysRemoved });
}
