import type { DNSResolver } from "mailauth";
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { authenticate } = await import("mailauth");
		const result = await Promise.race([
			authenticate(raw, {
				ip: connection.ip,
				helo: connection.helo,
				sender: connection.sender,
				mta: connection.authservId,
				disableArc: true,
				disableBimi: true,
				...(options.resolver ? { resolver: options.resolver } : {}),
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("SMTP authentication timed out")),
					options.timeoutMs ?? SMTP_AUTH_TIMEOUT_MS,
				);
			}),
		]);
		return authenticationResultsFromMailauth(result, connection.authservId);
	} catch (error) {
		console.warn("SMTP authentication check failed", error instanceof Error ? error.name : "unknown error");
		return null;
	} finally {
		clearTimeout(timer);
	}
}
