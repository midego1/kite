import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import { recordAuthActivity } from "@/lib/auth/activity";
import { resetUserSecondFactors } from "@/lib/auth/mfa";
import { checkReauthentication } from "@/lib/auth/passkey-http";
import { noticeSignInChange } from "@/lib/auth/sign-in-notice";
import { requireAccountAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { selectAccountById } from "../utils";

/**
 * Resets an account's second factors (TOTP, recovery codes, passkeys) and signs it out everywhere, for someone
 * locked out of their devices. The same rules as editing the account: admins without the primary role only for
 * plain users. The acting admin confirms with their own password (or authenticator code), so a stolen admin session
 * alone cannot strip someone's second factors, and the account holder is told by mail.
 */
export async function DELETE(request: Request, { params }: AccountRouteParams) {
	const access = await requireAccountAdmin(request);
	if (access.error) return access.error;
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
	const reauthError = await checkReauthentication(access.env, request, actor);
	if (reauthError) return reauthError;
	const { passkeysRemoved } = await resetUserSecondFactors(access.env, id);
	await recordAuthActivity(access.env, {
		action: "auth.mfa_reset",
		userId: id,
		actorUserId: actor.id,
		request,
		details: { passkeysRemoved },
	});
	await noticeSignInChange(access.env, account, { kind: "second_factors_reset", passkeysRemoved });
	return NextResponse.json({ ok: true, passkeysRemoved });
}
