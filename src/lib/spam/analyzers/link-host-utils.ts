/**
 * Pure checks on link hostnames for the URL analyzer and triage facts. Hostnames are expected the
 * way `new URL()` returns them: lowercase, internationalized labels already in `xn--` form.
 */

/** Second-level labels that ccTLDs commonly sell under, as in `example.co.uk` or `example.com.au`. */
const CC_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "go", "gob", "gov", "ne", "net", "or", "org"]);

/**
 * A small stand-in for the Public Suffix List: shared hosting names where every subdomain belongs to
 * someone else, so `attacker.github.io` is not treated as part of `github.io`.
 */
const SHARED_SUFFIXES = new Set([
	"appspot.com",
	"azurewebsites.net",
	"blogspot.com",
	"cloudfront.net",
	"firebaseapp.com",
	"github.io",
	"gitlab.io",
	"herokuapp.com",
	"netlify.app",
	"pages.dev",
	"r2.dev",
	"vercel.app",
	"web.app",
	"workers.dev",
]);

const URL_SHORTENERS = new Set([
	"bit.do",
	"bit.ly",
	"bitly.com",
	"buff.ly",
	"cutt.ly",
	"goo.gl",
	"is.gd",
	"ow.ly",
	"qrco.de",
	"rb.gy",
	"rebrand.ly",
	"s.id",
	"shorturl.at",
	"t.co",
	"t.ly",
	"tiny.cc",
	"tinyurl.com",
	"v.gd",
]);

/**
 * Click-tracking redirectors of mail services that put the destination in the link itself, so a link
 * through them counts as going to that destination.
 */
const CLICK_TRACKERS = new Set(["awstrack.me", "list-manage.com", "mandrillapp.com", "sparkpostmail.com"]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;

function cleanHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

/** A dotted IPv4 address (the URL parser also turns decimal and hex forms into one) or a bracketed IPv6 one. */
export function isIpHost(host: string): boolean {
	const value = cleanHost(host);
	return IPV4.test(value) || IPV6.test(value);
}

/**
 * The part of a hostname one owner controls: `mail.example.co.uk` gives `example.co.uk`. IP addresses
 * and single labels come back as they are.
 */
export function registrableDomain(host: string): string {
	const value = cleanHost(host).replace(/^www\./, "");
	if (isIpHost(value)) return value;
	const labels = value.split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	const shared = SHARED_SUFFIXES.has(lastTwo);
	const ccSecondLevel = labels.at(-1)!.length === 2 && CC_SECOND_LEVELS.has(labels.at(-2)!);
	return labels.slice(shared || ccSecondLevel ? -3 : -2).join(".");
}

export function sameRegistrableDomain(a: string, b: string): boolean {
	return registrableDomain(a) === registrableDomain(b);
}

export function isUrlShortener(host: string): boolean {
	return URL_SHORTENERS.has(cleanHost(host).replace(/^www\./, ""));
}

export function isClickTracker(host: string): boolean {
	return CLICK_TRACKERS.has(registrableDomain(host));
}

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const MAX_INT = 0x7fffffff;

function adapt(delta: number, points: number, first: boolean): number {
	let value = first ? Math.floor(delta / DAMP) : delta >> 1;
	value += Math.floor(value / points);
	let k = 0;
	while (value > ((BASE - T_MIN) * T_MAX) >> 1) {
		value = Math.floor(value / (BASE - T_MIN));
		k += BASE;
	}
	return k + Math.floor(((BASE - T_MIN + 1) * value) / (value + SKEW));
}

function digitOf(code: number): number {
	if (code >= 48 && code <= 57) return code - 22;
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 97;
	return BASE;
}

function threshold(k: number, bias: number): number {
	if (k <= bias) return T_MIN;
	return k >= bias + T_MAX ? T_MAX : k - bias;
}

/** Reads one variable-length integer starting at `start`; null when the input ends or overflows. */
function readDelta(input: string, start: number, bias: number): { delta: number; next: number } | null {
	let delta = 0;
	let index = start;
	for (let weight = 1, k = BASE; ; k += BASE) {
		if (index >= input.length) return null;
		const digit = digitOf(input.charCodeAt(index++));
		if (digit >= BASE || digit > Math.floor((MAX_INT - delta) / weight)) return null;
		delta += digit * weight;
		const t = threshold(k, bias);
		if (digit < t) return { delta, next: index };
		if (weight > Math.floor(MAX_INT / (BASE - t))) return null;
		weight *= BASE - t;
	}
}

/** RFC 3492 decoding of one label without its `xn--` prefix; null when it is not valid Punycode. */
export function decodePunycode(input: string): string | null {
	const delimiter = input.lastIndexOf("-");
	const output: number[] = [];
	for (let index = 0; index < Math.max(delimiter, 0); index++) {
		const code = input.charCodeAt(index);
		if (code >= 0x80) return null;
		output.push(code);
	}
	let codePoint = 0x80;
	let bias = 72;
	let position = 0;
	for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length;) {
		const read = readDelta(input, index, bias);
		if (!read) return null;
		index = read.next;
		const total = position + read.delta;
		const length = output.length + 1;
		bias = adapt(read.delta, length, position === 0);
		codePoint += Math.floor(total / length);
		position = total % length;
		if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
		output.splice(position++, 0, codePoint);
	}
	return String.fromCodePoint(...output);
}

/** The hostname with each `xn--` label decoded; a label that does not decode stays as it was. */
export function unicodeHost(host: string): string {
	return cleanHost(host)
		.split(".")
		.map((label) => (label.startsWith("xn--") ? (decodePunycode(label.slice(4)) ?? label) : label))
		.join(".");
}

// Cyrillic and Greek letters that render like Latin ones; a label made only of these imitates a Latin name.
const LATIN_LOOKALIKES = new Set([..."аеорсухіјѕԁӏһԛԝьвкмнтαβεικνορτυχ"]);
const SCRIPTS: readonly [string, RegExp][] = [
	["latin", /\p{Script=Latin}/u],
	["cyrillic", /\p{Script=Cyrillic}/u],
	["greek", /\p{Script=Greek}/u],
];

function lookalikeLabel(label: string): boolean {
	const letters = [...label].filter((char) => /\p{L}/u.test(char));
	const scripts = new Set(
		letters.map((char) => SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0]).filter(Boolean),
	);
	if (scripts.size > 1) return true;
	if (scripts.has("latin") || letters.length === 0) return false;
	return letters.every((char) => LATIN_LOOKALIKES.has(char));
}

/**
 * Whether an internationalized hostname imitates a Latin one: a label that mixes Latin, Cyrillic or
 * Greek letters, consists only of Cyrillic or Greek look-alikes of Latin letters, or is not valid Punycode.
 */
export function isLookalikeHost(host: string): boolean {
	return cleanHost(host)
		.split(".")
		.some((label) => {
			if (!label.startsWith("xn--")) return false;
			const decoded = decodePunycode(label.slice(4));
			return decoded === null || lookalikeLabel(decoded);
		});
}

// Text like `README.md` or `invoice.pdf` names a file, even where the extension is also a top-level domain.
const FILE_EXTENSIONS = new Set([
	..."csv doc docx eml exe gif htm html ics jpeg jpg js json md mov mp3 mp4 pdf png ppt pptx py rar rs sh svg ts txt xls xlsx xml zip".split(
		" ",
	),
]);
const BARE_HOST =
	/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]+)(?=$|[/:?#])/iu;

/**
 * The hostname a link's visible text shows when it reads as an address: a full `http(s)://` URL, or a
 * bare name such as `www.example.com` or `example.com/login`. Null for any other text.
 */
export function displayedHost(text: string): string | null {
	const value = text.trim();
	if (!value || /\s/.test(value) || value.includes("@")) return null;
	if (/^https?:\/\//i.test(value)) return hostOf(value);
	const match = value.match(BARE_HOST);
	if (!match) return null;
	const tld = match[0].split(".").at(-1)!.toLowerCase();
	if (FILE_EXTENSIONS.has(tld)) return null;
	return hostOf(`https://${value}`);
}

function hostOf(value: string): string | null {
	try {
		return new URL(value).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/** Hosts of `http(s)://` addresses written inside a tracking link, decoded once. */
function embeddedHosts(href: string): string[] {
	let decoded = href;
	try {
		decoded = decodeURIComponent(href);
	} catch {}
	const hosts: string[] = [];
	const rest = decoded.slice(decoded.indexOf("://") + 3);
	for (const match of rest.matchAll(/https?:\/\/[^\s/?#"'<>]+/gi)) {
		const host = hostOf(match[0]);
		if (host) hosts.push(host);
	}
	return hosts;
}

/**
 * Whether a link whose text shows one address leads somewhere else: the destination's registrable
 * domain differs from the one shown, unless a known click tracker carries the shown address inside it.
 */
export function linkTextMismatch(href: string, text: string): boolean {
	if (!/^https?:\/\//i.test(href.trim())) return false;
	const shown = displayedHost(text);
	const target = hostOf(href.trim());
	if (!shown || !target || sameRegistrableDomain(shown, target)) return false;
	if (isClickTracker(target)) return !embeddedHosts(href).some((host) => sameRegistrableDomain(host, shown));
	return true;
}

/** Up to `limit` distinct link hostnames (without `www.`) from text, in order of appearance. */
export function linkHostsOf(source: string, limit = 50): string[] {
	const hosts = new Set<string>();
	for (const match of source.slice(0, 250_000).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
		const host = hostOf(match[0])?.replace(/^www\./, "");
		if (host) hosts.add(host);
		if (hosts.size >= limit) break;
	}
	return [...hosts];
}

// Only plain host names and bracketed IPv6 reach the trusted facts, so a crafted host cannot carry prompt text.
const FACT_HOST = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$|^\[[0-9a-f:.]{2,45}\]$/;

/**
 * The sender's registrable domain and up to `limit` link hosts, each marked when it is on that domain.
 * Hosts that are not plain names are left out.
 */
export function summarizeLinks(
	senderAddress: string,
	hosts: readonly string[],
	limit = 10,
): { senderDomain: string | null; hosts: { host: string; sameAsSender: boolean }[] } {
	const at = senderAddress.lastIndexOf("@");
	const senderHost = at >= 0 ? cleanHost(senderAddress.slice(at + 1)) : "";
	const senderDomain = FACT_HOST.test(senderHost) && senderHost.includes(".") ? registrableDomain(senderHost) : null;
	return {
		senderDomain,
		hosts: hosts
			.map(cleanHost)
			.filter((host) => host.length <= 253 && FACT_HOST.test(host))
			.slice(0, limit)
			.map((host) => ({ host, sameAsSender: !!senderDomain && registrableDomain(host) === senderDomain })),
	};
}

/** The host and each parent of it down to its registrable domain: `a.mail.example.com` gives three names. */
export function hostAndParents(host: string): string[] {
	const value = cleanHost(host);
	if (!value) return [];
	const floor = registrableDomain(value);
	const labels = value.split(".");
	const names: string[] = [];
	for (let index = 0; index < labels.length; index++) {
		const name = labels.slice(index).join(".");
		names.push(name);
		if (name === floor) break;
	}
	return names;
}
