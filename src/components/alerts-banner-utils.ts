import type { ActiveAlertsResponse, BannerAlert } from "./alerts-banner-types";

const DISMISSED_ALERTS_KEY = "kite-dismissed-alerts";
export const ACTIVE_ALERTS_REFRESH_MS = 5 * 60_000;

type SignatureStorage = Pick<Storage, "getItem" | "setItem">;

function isBannerAlert(value: unknown): value is BannerAlert {
	if (!value || typeof value !== "object") return false;
	const alert = value as Record<string, unknown>;
	return (
		typeof alert.rule === "string" &&
		typeof alert.name === "string" &&
		typeof alert.count === "number" &&
		typeof alert.href === "string" &&
		alert.href.startsWith("/")
	);
}

/** Accepts only the fields the banner renders; anything unexpected reads as "nothing active". */
export function parseActiveAlerts(value: unknown): ActiveAlertsResponse {
	const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const alerts = Array.isArray(data.alerts) ? data.alerts.filter(isBannerAlert) : [];
	const signature = typeof data.signature === "string" && data.signature ? data.signature : null;
	return { enabled: data.enabled === true, alerts, signature };
}

export function shouldShowAlertsBanner(data: ActiveAlertsResponse | undefined, dismissed: string | null): boolean {
	if (!data || data.alerts.length === 0 || !data.signature) return false;
	return data.signature !== dismissed;
}

/** Storage can throw (disabled cookies, private mode); the banner then simply stays visible. */
export function readDismissedSignature(storage: SignatureStorage | undefined): string | null {
	try {
		return storage?.getItem(DISMISSED_ALERTS_KEY) ?? null;
	} catch {
		return null;
	}
}

export function storeDismissedSignature(storage: SignatureStorage | undefined, signature: string): void {
	try {
		storage?.setItem(DISMISSED_ALERTS_KEY, signature);
	} catch {
		// The dismissal still applies for this page view through component state.
	}
}
