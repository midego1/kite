import { authFetch } from "@/lib/auth/client";
import type {
	AbuseChKeyStatus,
	AbuseChService,
	KeyTestResult,
	KeyTestResults,
} from "@/lib/spam/providers/abuse-ch-types";
import { TELEMETRY_PRIVACY_CONTACT, telemetryDayLabel } from "@/lib/telemetry/telemetry-utils";
import { telemetryStartsLater } from "@/lib/telemetry/notice-utils";
import type { TelemetryErasure, TelemetryStatus } from "@/lib/telemetry/types";
import type { GeneralSettings, ThreatLookupKeySaved } from "./types";

export const THREAT_LOOKUP_SERVICES: readonly { service: AbuseChService; name: string }[] = [
	{ service: "urlhaus", name: "URLhaus" },
	{ service: "threatfox", name: "ThreatFox" },
];

export const KEY_TEST_TEXT: Record<KeyTestResult, string> = {
	works: "Key works",
	rejected: "Key rejected",
	unreachable: "abuse.ch unreachable",
};

export function lookupStatusText(name: string, configured: boolean | null): string {
	if (configured === null) return "Checking…";
	return `${name} lookups are ${configured ? "on" : "off"}`;
}

/** Where the key comes from, in the owner's words; the key itself is never shown. */
export function keyStatusText(status: AbuseChKeyStatus | null): string {
	if (!status) return "Checking…";
	if (status.source === "secret")
		return status.nodeRuntime ? "Key set in an environment variable (secret)" : "Key set in Cloudflare (secret)";
	if (status.source === "settings") return "Key saved in Kite";
	return status.unreadable ? "No key: the saved key cannot be read" : "No key";
}

async function keyRequest<T>(method: "PUT" | "DELETE", body?: unknown): Promise<T> {
	const response = await authFetch("/api/admin/threat-lookups/key", {
		method,
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not update the key");
	return data;
}

export function saveThreatLookupKey(authKey: string): Promise<ThreatLookupKeySaved> {
	return keyRequest<ThreatLookupKeySaved>("PUT", { authKey });
}

export async function removeThreatLookupKey(): Promise<AbuseChKeyStatus> {
	return (await keyRequest<{ status: AbuseChKeyStatus }>("DELETE")).status;
}

export async function loadGeneralSettings(): Promise<GeneralSettings> {
	const response = await authFetch("/api/admin/general", { cache: "no-store" });
	const data = (await response.json()) as GeneralSettings & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not load general settings");
	return data as GeneralSettings;
}

export async function saveGeneralSettings(outboundAttachmentMaxMb: number): Promise<GeneralSettings> {
	const response = await authFetch("/api/admin/general", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outboundAttachmentMaxMb }),
	});
	const data = (await response.json()) as GeneralSettings & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not save general settings");
	return data as GeneralSettings;
}

export async function testThreatLookupKey(): Promise<KeyTestResults> {
	const response = await authFetch("/api/admin/threat-lookups/test", { method: "POST" });
	const data = (await response.json().catch(() => ({}))) as Partial<KeyTestResults> & { error?: string };
	if (!response.ok || !data.urlhaus || !data.threatfox) throw new Error(data.error ?? "Could not test the key");
	return { urlhaus: data.urlhaus, threatfox: data.threatfox };
}

/** Where the usage statistics card's text comes from, in the owner's words. */
export function telemetryStatusText(status: TelemetryStatus | null): string {
	if (!status) return "Checking…";
	if (!status.available) return "Apply the pending database update first";
	if (status.forcedOff)
		return status.enabled
			? "Off: KITE_TELEMETRY on this deployment stops sending. Turn the switch off to delete this install’s ID"
			: "Off: turned off by the KITE_TELEMETRY setting of this deployment";
	if (!status.endpoint)
		return status.enabled
			? "On, but KITE_TELEMETRY_URL is empty or not a usable https address, so nothing is sent"
			: "Off";
	if (telemetryStartsLater(status))
		return `On by default: sending starts at 02:00 UTC on ${telemetryDayLabel(status.startDay)} unless you turn it off`;
	if (!status.enabled) return "Off";
	return status.lastSentDay ? `On, last attempted on ${status.lastSentDay} (UTC)` : "On, nothing sent yet";
}

/** What became of the collector's copy after turning statistics off; null when there is nothing to say. */
export function telemetryErasureText(erasure: TelemetryErasure | null): string | null {
	if (!erasure || erasure.outcome === "not_needed") return null;
	if (erasure.outcome === "erased") return "The collector erased this install’s reports.";
	return `Kite could not confirm that the collector erased this install’s reports. To have them removed, send this ID to ${TELEMETRY_PRIVACY_CONTACT}:`;
}
