import type { ZoneAdoptionCode } from "./skip-dns-types";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Whether a name can be a mail domain: dot-separated letters, digits and inner hyphens,
 * ending in an alphabetic or punycode top-level label. A domain added with DNS skipped is
 * never looked up on Cloudflare, so this is the only check its hostname gets.
 */
export function isDomainHostname(hostname: string): boolean {
	if (hostname.length > 253) return false;
	const labels = hostname.split(".");
	if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
	const tld = labels[labels.length - 1];
	return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

/**
 * Whether a domain should get its real Cloudflare zone now. Only a domain added with DNS
 * skipped is adopted: the manual zone of a self-hosted install without Cloudflare
 * credentials is deliberate and stays, and without credentials there is nothing to ask.
 */
export function shouldAdoptZone(domain: { zoneId: string; dnsSkipped: boolean }, hasCredentials: boolean): boolean {
	return domain.zoneId === "manual" && domain.dnsSkipped && hasCredentials;
}

/** Why the Cloudflare zone of a skipped domain could not be attached, with the HTTP status to answer. */
export class ZoneAdoptionError extends Error {
	readonly status: number;
	readonly code: ZoneAdoptionCode;

	constructor(code: ZoneAdoptionCode, message: string) {
		super(message);
		this.name = "ZoneAdoptionError";
		this.code = code;
		this.status = code === "ZONE_CLAIMED" ? 409 : code === "ZONE_NOT_FOUND" ? 422 : 502;
	}
}

/** The JSON answer for a failed zone adoption, or null for any other error. */
export function zoneAdoptionFailure(
	error: unknown,
): { status: number; body: { error: string; code: ZoneAdoptionCode } } | null {
	if (!(error instanceof ZoneAdoptionError)) return null;
	return { status: error.status, body: { error: error.message, code: error.code } };
}

/**
 * The row for a domain added with DNS skipped. It is active so mail is accepted as soon
 * as the operator's own DNS points at Kite (inbound routing only delivers to active
 * domains), and it names no provider, since none has been set up.
 */
export function skippedDomainValues(id: string, userId: string, hostname: string) {
	return {
		id,
		userId,
		hostname,
		zoneId: "manual",
		status: "active" as const,
		receivingProvider: "none" as const,
		sendingProvider: "none" as const,
		routingStatus: null,
		sendingSubdomainTag: null,
		sendingRequested: false,
		sendingEnabled: false,
		routingEnabled: false,
		dnsSkipped: true,
	};
}

/**
 * The zone view of a skipped domain on an install with Cloudflare credentials. The manual
 * zone's own record list describes this server's SMTP listener, which is wrong for a
 * domain that will be moved to Cloudflare, so it lists nothing until the zone is adopted.
 */
export function skippedDomainDns() {
	return {
		routing: { records: [], missing: [], status: "skipped" },
		sending: [],
		sendingEnabled: false,
	};
}

/**
 * What re-adding a domain with full provisioning changes about the "DNS skipped" flag:
 * provisioning has just set the DNS up, so an earlier skip's warning is cleared. Nothing
 * is written when the flag is already off, which keeps the update working before the
 * migration that adds the column.
 */
export function clearedDnsSkip(existing: { dnsSkipped: boolean } | null | undefined): { dnsSkipped?: false } {
	return existing?.dnsSkipped ? { dnsSkipped: false } : {};
}
