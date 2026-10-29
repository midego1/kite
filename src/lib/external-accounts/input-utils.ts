import { addressDomain, findPreset, isPresetId } from "./presets-utils";
import type { ExternalAccountInput, ExternalAccountView, MailServerSettings } from "./types";

/** A request body Kite refuses before anything connects; the message is shown as it is. */
export class AccountInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountInputError";
	}
}

const text = (value: unknown, max: number): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
};

function serverFrom(value: unknown, what: "IMAP" | "SMTP"): MailServerSettings | null {
	if (!value || typeof value !== "object") return null;
	const { host, port, security } = value as Record<string, unknown>;
	const name = text(host, 253);
	if (!name) return null;
	const number = Number(port);
	if (!Number.isInteger(number) || number < 1 || number > 65535)
		throw new AccountInputError(`The ${what} port is invalid`);
	if (security !== "tls" && security !== "starttls")
		throw new AccountInputError(`Choose TLS or STARTTLS for the ${what} server`);
	return { host: name.toLowerCase(), port: number, security };
}

type Body = Record<string, unknown>;

/** The servers of an account: a known preset's own, or for "Other" the request's (or, in an edit, the current). */
function parseServers(input: Body, presetId: ExternalAccountInput["preset"], current?: ExternalAccountView) {
	const preset = findPreset(presetId)!;
	if (presetId !== "other") return { imap: preset.imap, smtp: preset.smtp };
	const imap = input.imap === undefined ? current?.imap : serverFrom(input.imap, "IMAP");
	if (!imap?.host) throw new AccountInputError("Enter the IMAP server");
	const smtp = input.smtp === undefined ? (current?.smtp ?? null) : serverFrom(input.smtp, "SMTP");
	return { imap, smtp };
}

/** A text field of an edit: the request's value when sent, else the current one. */
function kept<T>(value: unknown, fallback: T, parse: (raw: unknown) => T): T {
	return value === undefined ? fallback : parse(value);
}

/**
 * The account settings of a connect request, or of an edit merged over `current`. A known preset always brings its
 * own servers, so only "Other" takes servers from the request; the user name defaults to the address.
 */
export function parseAccountInput(body: unknown, current?: ExternalAccountView): ExternalAccountInput {
	const input = (body && typeof body === "object" ? body : {}) as Body;
	const address = (text(input.address, 254) ?? current?.address ?? "").toLowerCase();
	if (!addressDomain(address)) throw new AccountInputError("Enter the account's email address");
	const presetId = input.preset === undefined ? (current?.preset ?? "other") : input.preset;
	if (!isPresetId(presetId)) throw new AccountInputError("Choose a provider");
	const mailboxId = text(input.mailboxId, 100) ?? current?.mailboxId;
	if (!mailboxId) throw new AccountInputError("Choose the mailbox this account's mail goes to");
	return {
		address,
		label: kept(input.label, current?.label ?? address, (raw) => text(raw, 100) ?? address),
		displayName: kept(input.displayName, current?.displayName ?? null, (raw) => text(raw, 200)),
		preset: presetId,
		mailboxId,
		...parseServers(input, presetId, current),
		username: kept(input.username, current?.username ?? address, (raw) => text(raw, 254) ?? address),
	};
}

/** Whether an edit changes what Kite signs in with, which needs a new test (and the Kite password). */
export function changesSignIn(
	current: ExternalAccountView,
	next: ExternalAccountInput,
	password: string | null,
): boolean {
	return (
		password !== null ||
		current.address !== next.address ||
		current.username !== next.username ||
		current.preset !== next.preset ||
		current.imap.host !== next.imap.host ||
		current.imap.port !== next.imap.port ||
		current.imap.security !== next.imap.security
	);
}

/** The account's password from a request: kept exactly as typed (passwords may start or end with spaces). */
export function passwordFrom(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
}
