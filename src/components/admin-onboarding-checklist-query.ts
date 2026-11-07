import { authFetch } from "@/lib/auth/client";
import type { OnboardingChecklistResponse } from "@/lib/admin/onboarding-checklist-types";

/** Shared by the admin overview and onboarding, so either dismissing refreshes both. */
export const ONBOARDING_CHECKLIST_QUERY = ["onboarding-checklist"] as const;

export async function fetchOnboardingChecklist(): Promise<OnboardingChecklistResponse> {
	const response = await authFetch("/api/admin/onboarding-checklist", { cache: "no-store" });
	if (!response.ok) throw new Error(`Onboarding checklist request failed (${response.status})`);
	return (await response.json()) as OnboardingChecklistResponse;
}

export async function saveOnboardingChecklistDismissed(dismissed: boolean): Promise<void> {
	const response = await authFetch("/api/admin/onboarding-checklist", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ dismissed }),
	});
	if (!response.ok) throw new Error(`Could not save the checklist (${response.status})`);
}
