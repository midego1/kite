import { authFetch } from "@/lib/auth/client";
import type { DnsAuthRecord, DnsAuthStatus, DomainPreflightResponse } from "./types";

export const dnsAuthRecords: DnsAuthRecord[] = ["mx", "spf", "dkim", "dmarc"];

export const dnsAuthDescriptions: Record<DnsAuthRecord, string> = {
	mx: "Routes incoming email to Kite",
	spf: "Authorizes Kite to send email",
	dkim: "Signs outgoing email for deliverability",
	dmarc: "Helps prevent email spoofing",
};

export function getDnsAuthStatusLabel(status: DnsAuthStatus): string {
	switch (status) {
		case "ok":
			return "found";
		case "missing":
			return "missing";
		default:
			return "not verified";
	}
}

export { ROW_BUTTON_CLASS } from "@/components/ui/page-utils";

export function getDnsAuthItemClass(status: DnsAuthStatus): string {
	switch (status) {
		case "ok":
			return "bg-[#22c55e]/10";
		case "missing":
			return "bg-[#ef4444]/10";
		default:
			return "bg-neutral-100 text-neutral-600";
	}
}

export async function checkDomain(hostname: string): Promise<DomainPreflightResponse> {
	const response = await authFetch("/api/domains/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hostname }),
	});
	const data = (await response.json()) as Omit<DomainPreflightResponse, "ok">;
	return { ok: response.ok, ...data };
}

/** The Email Sending row's text: the zone's sending subdomain when there is one, else the manual setup's state. */
export function getSendingStatusLabel(
	subdomainName: string | undefined,
	subdomainEnabled: boolean,
	manual: boolean,
	domainSendingEnabled: boolean,
): string {
	if (subdomainName) return `Sending for ${subdomainName} is ${subdomainEnabled ? "enabled" : "disabled"}`;
	if (!manual) return "Sending has not been configured for this domain";
	return domainSendingEnabled ? "Email sending is configured" : "Email sending is not configured";
}
