import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import {
	loadOnboardingChecklistState,
	readOnboardingChecklistDismissed,
	saveOnboardingChecklistDismissed,
} from "@/lib/admin/onboarding-checklist";
import { onboardingChecklistItems } from "@/lib/admin/onboarding-checklist-utils";
import type { OnboardingChecklistResponse } from "@/lib/admin/onboarding-checklist-types";
import { LayoutPreferencesPendingError } from "@/lib/preferences/layout";

const NO_STORE = { "Cache-Control": "no-store" };

/** Owner only: the "Get started" checklist, with every item's done state read fresh. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	const [state, dismissed] = await Promise.all([
		loadOnboardingChecklistState(env, auth.user),
		readOnboardingChecklistDismissed(env, auth.user.id),
	]);
	const body: OnboardingChecklistResponse = { dismissed, items: onboardingChecklistItems(state) };
	return NextResponse.json(body, { headers: NO_STORE });
}

/** Dismisses or restores the checklist for this owner only, with `{ dismissed }`. */
export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	const body = await request.json().catch(() => null);
	const dismissed = (body as { dismissed?: unknown } | null)?.dismissed;
	if (typeof dismissed !== "boolean")
		return NextResponse.json({ error: "Send { dismissed: boolean }" }, { status: 400 });
	try {
		await saveOnboardingChecklistDismissed(env, auth.user.id, dismissed);
	} catch (error) {
		if (!(error instanceof LayoutPreferencesPendingError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
	return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
