import type { ParsedEmail } from "@/lib/email/parse";
import type { PreparedSpamContent, SpamSignal } from "../types";
import { hasDisplayedLinkMismatch } from "./urls-utils";

export function analyzeUrls(message: ParsedEmail, prepared: PreparedSpamContent): SpamSignal[] {
	const domains = [...new Set([...prepared.urlDomains, ...prepared.attachmentUrlDomains])];
	const signals: SpamSignal[] = [];
	if (domains.some((domain) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)))
		signals.push({ id: "ip_address_url", score: 8, reason: "A link uses an IP address instead of a domain" });
	if (domains.some((domain) => domain.includes("xn--")))
		signals.push({ id: "punycode_url", score: 5, reason: "A link uses an internationalized domain encoding" });
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
