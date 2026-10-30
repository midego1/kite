import type { AuthenticateResult, DNSResolver } from "mailauth";
import { authenticationResultsFromMailauth } from "./smtp-auth-utils";

/**
 * SPF, DKIM and DMARC for mail the SMTP listener accepted itself (upstream Mailflare #215). No other hop verified it,
 * so the listener checks the connecting address, HELO name and envelope sender with mailauth and writes the outcome
 * as an `Authentication-Results` value under its own authserv-id. Intake hands that value on as the trusted one, so
 * `analyzeAuthentication` and the authentication policy read it like Cloudflare's. Node only: mailauth stays out of
 * the Worker and is external in the server bundle.
 */

/** Verification that takes longer is given up, and the message is delivered with authentication unknown. */
const SMTP_AUTH_TIMEOUT_MS = 10_000;

async function withinTimeout<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("SMTP authentication timed out")), timeoutMs ?? SMTP_AUTH_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Verifies the message as received from `connection` and answers the `Authentication-Results` value, or null when
 * verification failed or took longer than `SMTP_AUTH_TIMEOUT_MS` (a DNS outage leaves the sender unknown rather
 * than holding mail). `resolver` replaces DNS in tests.
 */
export async function verifySmtpAuthentication(
	raw: Buffer,
	connection: { ip: string; helo?: string; sender: string; authservId: string },
	options: { resolver?: DNSResolver; timeoutMs?: number } = {},
): Promise<string | null> {
	try {
		const { authenticate } = await import("mailauth");
		const result = await withinTimeout(
			authenticate(raw, {
				ip: connection.ip,
				helo: connection.helo,
				sender: connection.sender,
				mta: connection.authservId,
				disableArc: true,
				disableBimi: true,
				...(options.resolver ? { resolver: options.resolver } : {}),
			}),
			options.timeoutMs,
		);
		return authenticationResultsFromMailauth(result, connection.authservId);
	} catch (error) {
		console.warn("SMTP authentication check failed", error instanceof Error ? error.name : "unknown error");
		return null;
	}
}

/**
 * For a client on a private address, where the connecting address is not the sender's and SPF cannot be checked:
 * DKIM only, which does not depend on the address, and DMARC only when an aligned DKIM signature makes it pass. A
 * DMARC failure is never reported, since without SPF it may be a false one. Null when nothing could be verified.
 */
export async function verifyPrivateClientAuthentication(
	raw: Buffer,
	authservId: string,
	options: { resolver?: DNSResolver; timeoutMs?: number } = {},
): Promise<string | null> {
	try {
		const { dkimVerify, dmarc } = await import("mailauth");
		const resolver = options.resolver ? { resolver: options.resolver } : {};
		const result = await withinTimeout(
			(async () => {
				const dkim = await dkimVerify(raw, resolver);
				const passing = dkim.results.filter((signature) => signature.status?.result === "pass");
				const verdict =
					passing.length && dkim.headerFrom.length
						? await dmarc({
								headerFrom: dkim.headerFrom,
								fromFields: dkim.fromFields,
								fromSyntax: dkim.fromSyntax,
								spfDomains: [],
								dkimDomains: passing.map((signature) => ({
									id: signature.id,
									domain: signature.signingDomain ?? "",
									aligned: signature.status.aligned,
									underSized: signature.status.underSized,
								})),
								...resolver,
							})
						: false;
				return { dkim, dmarc: verdict && verdict.status?.result === "pass" ? verdict : false };
			})(),
			options.timeoutMs,
		);
		return authenticationResultsFromMailauth(
			{ spf: false, dkim: result.dkim, dmarc: result.dmarc } as AuthenticateResult,
			authservId,
		);
	} catch (error) {
		console.warn("SMTP DKIM check failed", error instanceof Error ? error.name : "unknown error");
		return null;
	}
}
