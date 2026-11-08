import { analyzeAuthentication } from "@/lib/spam/analyzers/authentication";
import { externalAuthenticationResults } from "@/lib/spam/authentication-results-utils";
import type { SpamSignal } from "@/lib/spam/types";
import type { ExternalAccountAuthRecheckView, ExternalAccountPresetId } from "./types";

/** How far back "Recheck authentication" reads, matching the Payments tab's "Scan last 90 days" convention. */
export const AUTH_RECHECK_SINCE_DAYS = 90;

/** Messages one run lists; each one that needs it reads its whole raw MIME from the Mail store. */
export const AUTH_RECHECK_PAGE_SIZE = 50;

/** A run's hold on a recheck; a run that died is taken over once it ran out, as the payment scan's lease works. */
export const AUTH_RECHECK_LEASE_MS = 120_000;

const AUTH_SIGNAL_IDS = new Set([
	"dmarc_passed",
	"dmarc_failed",
	"dkim_passed",
	"dkim_failed",
	"spf_passed",
	"spf_failed",
]);

export function parseStoredSignals(raw: string | null): SpamSignal[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as SpamSignal[]) : [];
	} catch {
		return [];
	}
}

/** Whether a message's stored signals already have a verdict for SPF, DKIM or DMARC, from any source. */
export function hasAuthenticationSignal(signals: readonly SpamSignal[]): boolean {
	return signals.some((signal) => AUTH_SIGNAL_IDS.has(signal.id));
}

/**
 * The authserv-id a connected account's own topmost header may be read under (spec §6.6.1), or null when the account
 * is not one "Recheck authentication" may read at all. Three checks, each redundant with the others by design (an
 * account row a future bug leaves inconsistent must still fail closed): the preset is Gmail or Google Workspace, the
 * preset's own `trustAuthResults` flag is set, and the account's IMAP host is exactly `imap.gmail.com` (never a
 * custom or edited host, which could point anywhere).
 */
export function authRecheckAuthservId(
	account: { preset: ExternalAccountPresetId; trustAuthResults: boolean; imapHost: string },
	presetAuthservId: string | null,
): string | null {
	if (!account.trustAuthResults || !presetAuthservId) return null;
	if (account.preset !== "gmail" && account.preset !== "google_workspace") return null;
	if (account.imapHost.toLowerCase() !== "imap.gmail.com") return null;
	return presetAuthservId;
}

export type RecheckOutcome = { kind: "updated"; signals: SpamSignal[] } | { kind: "unchanged" };

/**
 * One message's recheck (spec §6.6.1): nothing when it already has an authentication signal (whatever it says) or
 * when Google's own topmost header cannot be found and tied to its own `Received` line (`externalAuthenticationResults`,
 * the same trust rule live sync uses); otherwise the signals `analyzeAuthentication` computes, added to what the
 * message already has. Never removes or replaces an existing signal.
 */
export function recheckSignals(
	existingSignalsRaw: string | null,
	rawHeaderFields: readonly { name: string; value: string }[] | null,
	authservId: string,
	fromAddr: string,
): RecheckOutcome {
	const existing = parseStoredSignals(existingSignalsRaw);
	if (hasAuthenticationSignal(existing)) return { kind: "unchanged" };
	const trusted = externalAuthenticationResults(rawHeaderFields, authservId);
	if (!trusted) return { kind: "unchanged" };
	const fromDomain = fromAddr.slice(fromAddr.lastIndexOf("@") + 1).toLowerCase();
	const authentication = analyzeAuthentication(trusted, fromDomain);
	if (authentication.length === 0) return { kind: "unchanged" };
	return { kind: "updated", signals: [...existing, ...authentication] };
}

/** The queue message of one recheck run. @public Named by `AGENT_QUEUE` in env.d.ts. */
export type AuthRecheckMessage = { kind: "accounts.auth_recheck"; accountId: string };

export function authRecheckMessage(accountId: string): AuthRecheckMessage {
	return { kind: "accounts.auth_recheck", accountId };
}

export function isAuthRecheckMessage(body: unknown): body is AuthRecheckMessage {
	return (
		!!body &&
		typeof body === "object" &&
		(body as { kind?: unknown }).kind === "accounts.auth_recheck" &&
		typeof (body as { accountId?: unknown }).accountId === "string"
	);
}

export type AuthRecheckView = ExternalAccountAuthRecheckView | null;

export function authRecheckView(
	row: {
		status: "running" | "done" | "failed";
		scanned: number;
		updated: number;
		skipped: number;
		startedAt: Date;
		finishedAt: Date | null;
		error: string | null;
	} | null,
): AuthRecheckView {
	if (!row) return null;
	return {
		status: row.status,
		scanned: row.scanned,
		updated: row.updated,
		skipped: row.skipped,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
		error: row.error,
	};
}
