/** The cancel link of a subscription: only ever the first acceptable https URL of the `List-Unsubscribe` header. */
export type CancelLink = { url: string; oneClick: boolean };

const MAX_ENTRY = 2_048;
const ONE_CLICK = "List-Unsubscribe=One-Click";

function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.endsWith(".local") || host.endsWith(".internal")) return true;
	if (!host.includes(".")) return true;
	// IPv6 literals keep their brackets in `hostname`; IPv4 literals are all digits and dots.
	return host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

function acceptableUrl(entry: string): string | null {
	if (entry.length > MAX_ENTRY) return null;
	let url: URL;
	try {
		url = new URL(entry);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	if (isLocalHost(url.hostname)) return null;
	return url.href;
}

/** The `<...>` entries of an RFC 2369 header, in order. */
function headerEntries(header: string): string[] {
	return [...header.matchAll(/<([^<>]*)>/g)].map((match) => match[1].trim());
}

/**
 * The first `https:` URL of `List-Unsubscribe` whose host is a public name and which carries no
 * credentials; `http:` and `mailto:` entries are skipped. One-click is set only for the exact RFC 8058
 * `List-Unsubscribe-Post` value, and is informational: Kite never sends the POST.
 */
export function parseCancelLink(
	listUnsubscribe: string | null | undefined,
	listUnsubscribePost: string | null | undefined,
): CancelLink | null {
	if (!listUnsubscribe) return null;
	for (const entry of headerEntries(listUnsubscribe)) {
		const url = acceptableUrl(entry);
		if (url) return { url, oneClick: listUnsubscribePost?.trim() === ONE_CLICK };
	}
	return null;
}
