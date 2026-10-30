import { capChars } from "./inbound-limits";
import { parseRawHeaders } from "./raw-headers";

/**
 * Headers that would claim a verification nobody on Kite's side made: the sender can write any of them, so a header
 * map read from the message itself never carries them (Mailflare #224).
 */
const UNTRUSTED_HEADERS = new Set([
	"authentication-results",
	"arc-authentication-results",
	"arc-message-signature",
	"arc-seal",
	"received",
	"received-spf",
	"return-path",
]);

const MAX_HEADER_MAP_ENTRIES = 200;
const MAX_HEADER_MAP_VALUE_CHARS = 2000;

/**
 * The header map a provider that hands over none (Resend) would have given, read from the raw message: lower-case
 * names, the first value of each, at most 200 names of at most 2,000 characters each. Auto-reply suppression, mailbox
 * rules and automatic reading then see `Auto-Submitted`, `Precedence` and `List-Id` as they do for Cloudflare mail.
 */
export function readProviderHeaderMap(raw: ArrayBuffer): Record<string, string> {
	const map: Record<string, string> = {};
	let count = 0;
	for (const [name, values] of parseRawHeaders(raw)) {
		if (count >= MAX_HEADER_MAP_ENTRIES) break;
		if (UNTRUSTED_HEADERS.has(name) || name.startsWith("x-ses-") || Object.hasOwn(map, name)) continue;
		map[name] = capChars(values[0] ?? "", MAX_HEADER_MAP_VALUE_CHARS) ?? "";
		count++;
	}
	return map;
}
