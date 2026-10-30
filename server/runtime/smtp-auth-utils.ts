import { hostname as osHostname } from "node:os";
import type { AuthenticateResult } from "mailauth";

/** A value that may go into a header as it is: no spaces, separators, comments or quotes. */
const TOKEN = /^[^\s;()",\\]+$/;
const KEYWORD = /^[a-z]+$/;
const POLICIES = new Set(["none", "quarantine", "reject"]);

const token = (value: unknown): string | null => (typeof value === "string" && TOKEN.test(value) ? value : null);
const property = (name: string, value: unknown): string => {
	const safe = token(value);
	return safe ? ` ${name}=${safe}` : "";
};

function keyword(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const result = value === "temperr" ? "temperror" : value.toLowerCase();
	return KEYWORD.test(result) ? result : null;
}

/** The authserv-id Kite writes: `MAIL_HOSTNAME`, else the machine's name, else `kite`. */
export function smtpAuthservId(hostname: string | undefined): string {
	return token(hostname?.trim().toLowerCase()) ?? token(osHostname().toLowerCase()) ?? "kite";
}

function spfClause(spf: AuthenticateResult["spf"]): string[] {
	if (!spf) return [];
	const result = keyword(spf.status?.result);
	if (!result) return [];
	const mailfrom = property("smtp.mailfrom", spf.status?.smtp?.mailfrom ?? spf["envelope-from"]);
	return [`spf=${result}${mailfrom || property("smtp.helo", spf.status?.smtp?.helo ?? spf.helo)}`];
}

function dkimClauses(dkim: AuthenticateResult["dkim"] | undefined): string[] {
	if (!dkim) return [];
	const signatures = dkim.results ?? [];
	if (signatures.length === 0) return ["dkim=none"];
	return signatures.flatMap((signature) => {
		const result = keyword(signature.status?.result);
		return result
			? [`dkim=${result}${property("header.d", signature.signingDomain)}${property("header.s", signature.selector)}`]
			: [];
	});
}

function dmarcClause(dmarc: AuthenticateResult["dmarc"]): string[] {
	if (!dmarc) return [];
	const result = keyword(dmarc.status?.result);
	if (!result) return [];
	const policy = dmarc.policy?.toLowerCase();
	return [
		`dmarc=${result}${property("header.from", dmarc.status?.header?.from ?? dmarc.domain)}${policy && POLICIES.has(policy) ? ` policy.dmarc=${policy}` : ""}`,
	];
}

/**
 * The `Authentication-Results` value for mailauth's result, in the shape Cloudflare writes: SPF with
 * `smtp.mailfrom` (or `smtp.helo` for a null sender), one `dkim=` per signature with `header.d`, and DMARC with
 * `header.from` and the published policy as `policy.dmarc`. Text that is not a plain token is left out, so nothing
 * the sender chose can add a result. Null when no method gave one.
 */
export function authenticationResultsFromMailauth(result: AuthenticateResult, authservId: string): string | null {
	const results = [...spfClause(result.spf), ...dkimClauses(result.dkim), ...dmarcClause(result.dmarc)];
	return results.length ? [token(authservId) ?? "kite", ...results].join("; ") : null;
}

/** RFC 5322 date-time for a trace field. */
function traceDate(date: Date): string {
	return date.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * The `Received` field the listener prepends (RFC 5321 §4.4): the HELO name as given, the connecting address as the
 * socket saw it, Kite's host name and the session id. Sender-chosen text that is not a plain token is left out, so
 * nothing the sender wrote can end the field or start another.
 */
export function trustedReceivedHeader(input: {
	helo?: string;
	remoteAddress: string;
	clientHostname?: string;
	by: string;
	secure: boolean;
	sessionId: string;
	date?: Date;
}): string {
	const helo = token(input.helo) ?? "unknown";
	const address = token(input.remoteAddress.replace(/^::ffff:/, "")) ?? "unknown";
	const reverse = token(input.clientHostname);
	const source = reverse && reverse !== `[${address}]` ? `${reverse} [${address}]` : `[${address}]`;
	const id = token(input.sessionId);
	return `Received: from ${helo} (${source}) by ${token(input.by) ?? "kite"} (Kite) with ${input.secure ? "ESMTPS" : "ESMTP"}${id ? ` id ${id}` : ""}; ${traceDate(input.date ?? new Date())}`;
}
