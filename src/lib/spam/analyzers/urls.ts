import type { ParsedEmail } from "@/lib/email/parse";
import type { PreparedSpamContent, SpamSignal } from "../types";
import { isIpHost, isLookalikeHost, isUrlShortener } from "./link-host-utils";
import { displayedLinkFinding } from "./urls-utils";

function punycodeSignal(domains: readonly string[]): SpamSignal | null {
	const encoded = domains.filter((domain) => domain.includes("xn--"));
	if (encoded.length === 0) return null;
	if (encoded.some(isLookalikeHost))
		return {
			id: "punycode_url",
			score: 10,
			reason: "A link's domain imitates another name with letters from a different alphabet",
			metadata: { lookalike: true },
		};
	return { id: "punycode_url", score: 5, reason: "A link uses an internationalized domain encoding" };
}

export function analyzeUrls(
	message: ParsedEmail,
	prepared: PreparedSpamContent,
	senderDomain: string | null = null,
): SpamSignal[] {
	const domains = [...new Set([...prepared.urlDomains, ...prepared.attachmentUrlDomains])];
	const signals: SpamSignal[] = [];
	if (domains.some(isIpHost))
		signals.push({ id: "ip_address_url", score: 8, reason: "A link uses an IP address instead of a domain" });
	const punycode = punycodeSignal(domains);
	if (punycode) signals.push(punycode);
	if (domains.some(isUrlShortener))
		signals.push({
			id: "url_shortener",
			score: 2,
			reason: "A link goes through a URL shortener that hides where it leads",
		});
	if (domains.length > 10)
		signals.push({
			id: "many_link_domains",
			score: Math.min(8, domains.length - 8),
			reason: "Message links to an unusually large number of domains",
			metadata: { count: domains.length },
		});
	let senderTracked = false;
	for (const html of [message.html ?? "", ...prepared.webPageAttachments.map((page) => page.text)]) {
		const finding = displayedLinkFinding(html, senderDomain);
		if (finding === "mismatch") {
			signals.push({
				id: "displayed_link_mismatch",
				score: 10,
				reason: "A link's displayed address differs from its destination",
			});
			return signals;
		}
		if (finding === "sender_tracked") senderTracked = true;
	}
	// Not a finding: it only lets the threat lookups see links that would otherwise have been flagged.
	if (senderTracked)
		signals.push({
			id: "sender_tracked_link",
			score: 0,
			reason: "A link shows the authenticated sender's own address and goes through its mail service's click tracking",
		});
	return signals;
}
