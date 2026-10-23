import type { ParsedEmail } from "@/lib/email/parse";
import type { PreparedSpamContent, SpamSignal } from "../types";
import { isIpHost, isLookalikeHost, isUrlShortener } from "./link-host-utils";
import { hasDisplayedLinkMismatch } from "./urls-utils";

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

export function analyzeUrls(message: ParsedEmail, prepared: PreparedSpamContent): SpamSignal[] {
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
	for (const html of [message.html ?? "", ...prepared.webPageAttachments.map((page) => page.text)]) {
		if (hasDisplayedLinkMismatch(html)) {
			signals.push({
				id: "displayed_link_mismatch",
				score: 10,
				reason: "A link's displayed address differs from its destination",
			});
			return signals;
		}
	}
	return signals;
}
