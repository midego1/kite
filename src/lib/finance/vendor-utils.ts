import { VENDOR_NOISE } from "./keywords-utils";

/** Second-level labels under which a registrable domain has three labels (`example.co.uk`). */
const SHORT_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"ac.uk",
	"gov.uk",
	"me.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.nz",
	"co.jp",
	"ne.jp",
	"or.jp",
	"co.za",
	"com.br",
	"com.mx",
	"co.in",
	"com.sg",
	"com.hk",
	"com.tr",
	"com.ar",
	"co.kr",
	"com.cn",
	"com.tw",
]);

/** Payment processors and app stores that send receipts for many vendors, so the key also names the vendor. */
const PROCESSOR_DOMAINS = new Set([
	"stripe.com",
	"paddle.com",
	"paypal.com",
	"apple.com",
	"google.com",
	"fastspring.com",
	"chargebee.com",
]);

const MAX_VENDOR = 80;
/** How much of a display name is read; well above MAX_VENDOR so trailing noise words still go. */
const MAX_VENDOR_INPUT = 256;
// Control characters, bidirectional controls, zero-width and other invisible format characters.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** Text from mail or a model with control, bidirectional and invisible characters removed and spaces collapsed. */
export function cleanText(value: string, max: number): string {
	return value.replace(UNSAFE_TEXT, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

export function senderAddress(from: string): string {
	const match = /<([^<>]+)>/.exec(from);
	return (match ? match[1] : from).trim().toLowerCase();
}

function senderDomain(from: string): string {
	const address = senderAddress(from);
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1).replace(/\.$/, "");
}

export function senderLocalPart(from: string): string {
	const address = senderAddress(from);
	const at = address.lastIndexOf("@");
	return at === -1 ? address : address.slice(0, at);
}

/** The last two labels of the domain, or three under a short public suffix such as `co.uk`.
 * @public Exercised by the bundled unit tests.
 */
export function registrableDomain(domain: string): string {
	const labels = domain.toLowerCase().split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return SHORT_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function senderUsesUsDomain(from: string): boolean {
	return senderDomain(from).endsWith(".us");
}

function capitalise(value: string): string {
	return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** The vendor from the sender name without "Billing", "via …", quotes and the like; the domain label otherwise. */
/** A vendor name from a display name or the model: quotes, "via …", noise words and unsafe characters removed; "" when nothing usable is left. */
export function cleanVendorName(value: string): string {
	// Display names are unbounded; the regexes below backtrack, so clip first.
	const name = cleanText(
		value
			.slice(0, MAX_VENDOR_INPUT)
			.replace(/["'“”‘’]/g, "")
			.replace(/\s+via\s+.*$/i, "")
			.replace(new RegExp(VENDOR_NOISE.source, "giu"), " ")
			.replace(/[\s,:|·-]+$/u, "")
			.replace(/^[\s,:|·-]+/u, ""),
		MAX_VENDOR,
	);
	return name.includes("@") ? "" : name;
}

export function vendorName(fromName: string | null, from: string): { vendor: string; fromDomain: boolean } {
	const name = cleanVendorName(fromName ?? "");
	if (name) return { vendor: name, fromDomain: false };
	const domain = registrableDomain(senderDomain(from));
	const label = domain.split(".")[0] ?? "";
	return { vendor: cleanText(capitalise(label), MAX_VENDOR), fromDomain: true };
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

/** The vendor key of a subscription added by hand without a sender: `manual:<vendor slug>`. */
export function manualVendorKey(vendor: string): string {
	return `manual:${slug(vendor) || "subscription"}`;
}

/**
 * The sender's registrable domain, lower case; for a payment processor `<domain>:<vendor slug>`, so two
 * App Store subscriptions stay apart. Null when the sender has no usable domain.
 */
export function vendorKey(from: string, vendor: string): string | null {
	const domain = registrableDomain(senderDomain(from)).replace(/[^a-z0-9.-]/g, "");
	if (!domain.includes(".")) return null;
	if (!PROCESSOR_DOMAINS.has(domain)) return domain.slice(0, 120);
	const name = slug(vendor);
	return name ? `${domain}:${name}`.slice(0, 120) : domain;
}

/** Where a processor's receipt names the merchant: "Your receipt from Acme #1234", "Your Acme receipt [#1234]". */
const MERCHANT_IN_SUBJECT = [
	/^\s*(?:your\s+)?(?:receipt|invoice|refund)\s+from\s+(.{2,80}?)\s*(?:[#[(]|$)/iu,
	/^\s*your\s+(.{2,80}?)\s+(?:receipt|invoice|refund)(?![\p{L}])/iu,
];
// The name ends before a reference ("Receipt from Acme #2214-0001") as in the subject.
const MERCHANT_IN_BODY = /(?:^|\n)[ \t]*(?:receipt|invoice|refund)\s+from\s+([^\n#[(]{2,80}?)[ \t]*(?:[#[(]|\n|$)/iu;

/** The processor's own name, as its display name or without one: "Stripe", "PayPal", "Paddle.com". */
function genericProcessorName(name: string, domain: string): boolean {
	const label = domain.split(".")[0] ?? "";
	const plain = name.toLowerCase().replace(/[^a-z]/g, "");
	return !plain || plain === label || plain === `${label}com` || plain === `${label}payments`;
}

function merchantFrom(text: string | null, patterns: readonly RegExp[]): string {
	for (const pattern of patterns) {
		const found = pattern.exec((text ?? "").slice(0, 300))?.[1];
		const name = found ? cleanVendorName(found.replace(/[.!,;:]+$/u, "")) : "";
		if (name) return name;
	}
	return "";
}

/**
 * The vendor of a message: as `vendorName`, except that mail a payment processor sends for a merchant under its own
 * name ("Stripe <receipts+acct_…@stripe.com>") names the merchant the receipt is from, taken from the subject or a
 * "Receipt from …" line, so the vendor and its key are the merchant's, not the processor's (spec §25.1).
 */
export function messageVendor(
	fromName: string | null,
	from: string,
	subject: string | null,
	excerpt: string | null,
): { vendor: string; fromDomain: boolean } {
	const named = vendorName(fromName, from);
	const domain = registrableDomain(senderDomain(from));
	if (!PROCESSOR_DOMAINS.has(domain) || !genericProcessorName(named.fromDomain ? "" : named.vendor, domain))
		return named;
	const merchant = merchantFrom(subject, MERCHANT_IN_SUBJECT) || merchantFrom(excerpt, [MERCHANT_IN_BODY]);
	if (!merchant || genericProcessorName(merchant, domain)) return named;
	return { vendor: merchant, fromDomain: false };
}
