import type {
	AuthResult,
	CollectFactsInput,
	DeterministicPhishingSignal,
	FactsAttachment,
	FactsContact,
	MessageFacts,
} from "./facts-types";
import type { AutoReadCapabilities } from "./settings-types";

const AUTOMATIC_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;
const NO_REPLY_SENDER = /^(no-?reply|do-?not-?reply)@/i;
const URL_SIGNALS = ["displayed_link_mismatch", "ip_address_url", "punycode_url"] as const;
const AUTH_METHODS = ["spf", "dkim", "dmarc"] as const;

// Local parsing keeps this module free of runtime imports so tests can load it directly.
function senderParts(value: string): { address: string; name: string | null } {
	const angle = value.match(/^(.*)<([^<>]+)>\s*$/);
	if (!angle) return { address: value.trim().toLowerCase(), name: null };
	const name = angle[1]
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.trim();
	return { address: angle[2].trim().toLowerCase(), name: name || null };
}

function lowerHeaders(headers?: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]),
	);
}

/** Mail no person wrote: bounces, no-reply senders, lists, bulk mail and auto-responders. */
export function isAutomaticMessage(from: string, headers?: Record<string, string>) {
	if (AUTOMATIC_SENDER.test(senderParts(from).address)) return true;
	const values = lowerHeaders(headers);
	return !!(
		values["list-id"] ||
		values["x-autoreply"] ||
		values["x-autorespond"] ||
		values["x-auto-response-suppress"] ||
		(values["auto-submitted"] && values["auto-submitted"] !== "no") ||
		/^(bulk|junk|list)$/.test(values.precedence ?? "")
	);
}

function parseSignalIds(value: string | null): Set<string> {
	if (!value) return new Set();
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(
			parsed
				.map((signal) => (signal && typeof signal === "object" ? (signal as { id?: unknown }).id : null))
				.filter((id): id is string => typeof id === "string"),
		);
	} catch {
		return new Set();
	}
}

function authResult(signals: Set<string>, method: (typeof AUTH_METHODS)[number]): AuthResult {
	if (signals.has(`${method}_failed`)) return "fail";
	if (signals.has(`${method}_passed`)) return "pass";
	return "unknown";
}

/** `text/calendar` (any parameters), `application/ics`, or a `.ics` filename. */
export function isCalendarAttachment(attachment: Pick<FactsAttachment, "filename" | "contentType">): boolean {
	const type = attachment.contentType.trim().toLowerCase();
	return (
		type.startsWith("text/calendar") ||
		type.startsWith("application/ics") ||
		attachment.filename.trim().toLowerCase().endsWith(".ics")
	);
}

export function normalizeDisplayName(name: string | null | undefined): string {
	return (name ?? "").normalize("NFKC").replace(/["'`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isTrustedContact(contact: FactsContact): boolean {
	return contact.source === "manual" || contact.source === "outbound";
}

/**
 * A known contact the sender impersonates: same display name (or the contact's address used as the
 * display name) with a different address. Inbound-only contacts do not count, because intake saves
 * every sender as one before triage runs.
 */
export function findSpoofedContact(
	senderAddress: string,
	senderName: string | null,
	contacts: FactsContact[],
): string | null {
	const name = normalizeDisplayName(senderName);
	if (!name) return null;
	for (const contact of contacts) {
		const email = contact.email.trim().toLowerCase();
		if (!isTrustedContact(contact) || email === senderAddress) continue;
		if (name === email || name === normalizeDisplayName(contact.displayName)) return email;
	}
	return null;
}

function isKnownContact(signals: Set<string>, senderAddress: string, contacts: FactsContact[]): boolean {
	if (signals.has("manual_contact") || signals.has("previously_sent")) return true;
	return contacts.some((contact) => contact.email.trim().toLowerCase() === senderAddress && isTrustedContact(contact));
}

function spamVerdict(value: string | null): MessageFacts["spamVerdict"] {
	return value === "inbox" || value === "suspicious" || value === "spam" ? value : null;
}

function phishingSignals(
	signals: Set<string>,
	verdict: MessageFacts["spamVerdict"],
	auth: MessageFacts["auth"],
	spoofedContact: string | null,
): DeterministicPhishingSignal[] {
	const found: DeterministicPhishingSignal[] = [];
	if (verdict === "suspicious") found.push("suspicious_verdict");
	for (const id of URL_SIGNALS) if (signals.has(id)) found.push(id);
	for (const method of AUTH_METHODS) if (auth[method] === "fail") found.push(`${method}_failed`);
	if (spoofedContact) found.push("display_name_spoof");
	return found;
}

export function collectFacts(input: CollectFactsInput): MessageFacts {
	const { message } = input;
	const parts = senderParts(message.fromAddr);
	const senderAddress = parts.address;
	const headers = lowerHeaders(input.headers);
	const signals = parseSignalIds(message.spamSignals);
	const contacts = input.contacts ?? [];
	const auth = {
		spf: authResult(signals, "spf"),
		dkim: authResult(signals, "dkim"),
		dmarc: authResult(signals, "dmarc"),
	};
	const authFailed = AUTH_METHODS.some((method) => auth[method] === "fail");
	const verdict = spamVerdict(message.spamVerdict);
	const spoofedContact = findSpoofedContact(senderAddress, parts.name, contacts);
	const list = !!headers["list-id"];
	return {
		senderAddress,
		senderName: parts.name,
		automatic: isAutomaticMessage(message.fromAddr, input.headers),
		bulk: list || /^(bulk|junk|list)$/.test(headers.precedence ?? "") || !!headers["list-unsubscribe"],
		list,
		noReply: NO_REPLY_SENDER.test(senderAddress),
		listUnsubscribe: input.headers
			? (Object.entries(input.headers).find(([key]) => key.toLowerCase() === "list-unsubscribe")?.[1] ?? null)
			: null,
		auth,
		authPassed: !authFailed && (auth.dkim === "pass" || auth.dmarc === "pass"),
		authFailed,
		spamVerdict: verdict,
		suspicious: verdict === "suspicious",
		knownContact: isKnownContact(signals, senderAddress, contacts),
		spoofedContact,
		phishingSignals: phishingSignals(signals, verdict, auth, spoofedContact),
		inviteAttachments: (input.attachments ?? []).filter(isCalendarAttachment),
		bodyLength: (input.bodyText ?? message.textBody ?? "").length,
	};
}

/** Whether triage needs the model at all; bulk, list and no-reply mail is settled from facts alone. */
export function needsModel(facts: MessageFacts, capabilities: AutoReadCapabilities): boolean {
	if (facts.automatic || facts.bulk || facts.noReply || facts.spamVerdict === "spam") return false;
	if (capabilities.mutedSenders.includes(facts.senderAddress)) return false;
	return capabilities.reply || capabilities.summary || capabilities.phishing;
}
