import type { ExternalAccountPreset, ExternalAccountPresetId, MailServerSettings } from "./types";

const tls = (host: string, port: number): MailServerSettings => ({ host, port, security: "tls" });
const starttls = (host: string, port: number): MailServerSettings => ({ host, port, security: "starttls" });

const MB = 1_000_000;

const GMAIL_SERVERS = { imap: tls("imap.gmail.com", 993), smtp: tls("smtp.gmail.com", 465) };

/**
 * The providers Kite knows (spec §10.2 `preset`). `authservId` is the authserv-id of the provider's own
 * Authentication-Results header (§6.6); it is set only where it has been tied to the provider's hop, and null means
 * the header is never trusted. `appendSent` is false where the provider saves SMTP submissions in Sent itself.
 * `maxMessageBytes` is the provider's limit on one message as sent (attachments base64-encoded), counted in decimal
 * megabytes to stay under it; "Other" relies on the size its server announces.
 * Microsoft accounts sign in only with Microsoft's OAuth (§15.5), which Kite does not offer yet.
 */
export const EXTERNAL_ACCOUNT_PRESETS: readonly ExternalAccountPreset[] = [
	{
		id: "gmail",
		label: "Gmail",
		domains: ["gmail.com", "googlemail.com"],
		mxSuffixes: [],
		...GMAIL_SERVERS,
		appendSent: false,
		maxMessageBytes: 25 * MB,
		authservId: "mx.google.com",
		passwordSignIn: true,
		passwordHelp: "Use an app password: Google Account → Security → 2-Step Verification → App passwords.",
	},
	{
		id: "google_workspace",
		label: "Google Workspace",
		domains: [],
		mxSuffixes: ["aspmx.l.google.com", "googlemail.com", "smtp.google.com"],
		...GMAIL_SERVERS,
		appendSent: false,
		maxMessageBytes: 25 * MB,
		authservId: "mx.google.com",
		passwordSignIn: true,
		passwordHelp: "Use an app password, if your Workspace admin allows them.",
	},
	{
		id: "microsoft",
		label: "Outlook.com or Microsoft 365",
		domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com"],
		mxSuffixes: ["mail.protection.outlook.com", "olc.protection.outlook.com"],
		imap: tls("outlook.office365.com", 993),
		smtp: starttls("smtp.office365.com", 587),
		appendSent: false,
		maxMessageBytes: 20 * MB,
		authservId: null,
		passwordSignIn: false,
		passwordHelp: "Microsoft accounts need Microsoft sign-in, which Kite does not support yet.",
	},
	{
		id: "icloud",
		label: "iCloud Mail",
		domains: ["icloud.com", "me.com", "mac.com"],
		mxSuffixes: ["mail.icloud.com"],
		imap: tls("imap.mail.me.com", 993),
		smtp: starttls("smtp.mail.me.com", 587),
		appendSent: true,
		maxMessageBytes: 20 * MB,
		authservId: null,
		passwordSignIn: true,
		passwordHelp: "Use an app-specific password: Apple Account → Sign-In and Security → App-Specific Passwords.",
	},
	{
		id: "yahoo",
		label: "Yahoo Mail",
		domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
		mxSuffixes: ["yahoodns.net"],
		imap: tls("imap.mail.yahoo.com", 993),
		smtp: tls("smtp.mail.yahoo.com", 465),
		appendSent: true,
		maxMessageBytes: 25 * MB,
		authservId: null,
		passwordSignIn: true,
		passwordHelp: "Use an app password: Yahoo Account Security → Generate app password.",
	},
	{
		id: "aol",
		label: "AOL Mail",
		domains: ["aol.com", "aim.com"],
		mxSuffixes: [],
		imap: tls("imap.aol.com", 993),
		smtp: tls("smtp.aol.com", 465),
		appendSent: true,
		maxMessageBytes: 25 * MB,
		authservId: null,
		passwordSignIn: true,
		passwordHelp: "Use an app password: AOL Account Security → Generate app password.",
	},
	{
		id: "fastmail",
		label: "Fastmail",
		domains: ["fastmail.com", "fastmail.fm"],
		mxSuffixes: ["messagingengine.com"],
		imap: tls("imap.fastmail.com", 993),
		smtp: tls("smtp.fastmail.com", 465),
		appendSent: true,
		maxMessageBytes: 70 * MB,
		authservId: null,
		passwordSignIn: true,
		passwordHelp: "Use an app password: Fastmail Settings → Privacy & Security → Manage app passwords.",
	},
	{
		id: "other",
		label: "Other IMAP provider",
		domains: [],
		mxSuffixes: [],
		imap: tls("", 993),
		smtp: tls("", 465),
		appendSent: true,
		maxMessageBytes: null,
		authservId: null,
		passwordSignIn: true,
		passwordHelp: "Use the password or app password your provider gives mail apps.",
	},
];

const PRESET_IDS = EXTERNAL_ACCOUNT_PRESETS.map((preset) => preset.id);

export function findPreset(id: string): ExternalAccountPreset | null {
	return EXTERNAL_ACCOUNT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isPresetId(value: unknown): value is ExternalAccountPresetId {
	return typeof value === "string" && PRESET_IDS.includes(value as ExternalAccountPresetId);
}

/** The domain of an address, lower-case, or null when it is not `local@domain`. */
export function addressDomain(address: string): string | null {
	const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(address.trim().toLowerCase());
	return match ? match[1].replace(/\.$/, "") : null;
}

/** The preset a well-known mail domain belongs to (`gmail.com`, `icloud.com`, `yahoo.co.uk`), or null. */
export function presetForDomain(domain: string): ExternalAccountPreset | null {
	const value = domain.toLowerCase();
	const known = EXTERNAL_ACCOUNT_PRESETS.find((preset) => preset.domains.includes(value));
	if (known) return known;
	// Yahoo's country domains: yahoo.co.uk, yahoo.de, yahoo.com.au.
	if (/^yahoo\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(value)) return findPreset("yahoo");
	if (/^(?:outlook|hotmail|live)\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(value))
		return findPreset("microsoft");
	return null;
}

/** The host of an MX answer such as `10 aspmx.l.google.com.`, lower-case and without the trailing dot. */
export function mxHost(answer: string): string | null {
	const host = answer.trim().split(/\s+/).pop()?.toLowerCase().replace(/\.$/, "");
	return host || null;
}

/** The preset a custom domain's MX hosts point at (Google Workspace, Microsoft 365, iCloud+, Fastmail), or null. */
export function presetForMx(hosts: readonly string[]): ExternalAccountPreset | null {
	for (const host of hosts) {
		const value = host.toLowerCase().replace(/\.$/, "");
		const preset = EXTERNAL_ACCOUNT_PRESETS.find((entry) =>
			entry.mxSuffixes.some((suffix) => value === suffix || value.endsWith(`.${suffix}`)),
		);
		if (preset) return preset;
	}
	return null;
}

/**
 * Domains reserved for documentation and testing (RFC 2606, RFC 6761) never have real MX records worth asking for,
 * so detection does not look them up.
 */
export function isReservedMailDomain(domain: string): boolean {
	return (
		/\.(?:test|example|invalid|localhost|local|internal)$/.test(domain) ||
		/^(?:[^.]+\.)*example\.(?:com|net|org)$/.test(domain)
	);
}

/** Whether the provider's topmost Authentication-Results may be trusted for this preset (spec §6.6). */
export function presetTrustsAuthResults(preset: ExternalAccountPreset): boolean {
	return preset.authservId !== null;
}
