import type { Branding } from "@/lib/branding/types";

export const DEFAULT_BRANDING: Branding = {
	appName: "Kite",
	hasCustomIcon: false,
};

/** The current branding, or null when the server did not answer in time or failed: keep what is shown. */
export async function fetchBranding(): Promise<Branding | null> {
	try {
		const response = await fetch("/api/branding", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		return (await response.json()) as Branding;
	} catch {
		return null;
	}
}
