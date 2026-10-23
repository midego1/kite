import { authFetch } from "@/lib/auth/client";
import type { AbuseChService, KeyTestResult, KeyTestResults } from "@/lib/spam/providers/abuse-ch-types";
import type { GeneralSettings } from "./types";

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
