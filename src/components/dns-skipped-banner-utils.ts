import type { DnsSkippedBannerContent, SkippedDomain } from "./dns-skipped-banner-types";

/**
 * The domains still flagged as added with DNS skipped, from a `/api/domains` answer.
 * Anything unexpected reads as no domain, so the banner stays quiet rather than warning
 * about nothing (the flag is absent before its migration is applied).
 */
export function parseSkippedDomains(value: unknown): SkippedDomain[] {
	const list = value && typeof value === "object" ? (value as { domains?: unknown }).domains : undefined;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const { id, hostname, dnsSkipped } = item as Record<string, unknown>;
		return dnsSkipped === true && typeof id === "string" && typeof hostname === "string" ? [{ id, hostname }] : [];
	});
}

/** What the banner says about one or more domains whose DNS has not been set up. */
export function dnsSkippedBannerContent(domains: SkippedDomain[]): DnsSkippedBannerContent {
	const subject = domains.length === 1 ? domains[0].hostname : `${domains.length} domains`;
	return {
		title: `DNS setup was skipped for ${subject}`,
		body:
			domains.length === 1
				? "Mail will not arrive until its DNS records are set."
				: "Mail will not arrive until their DNS records are set.",
	};
}
