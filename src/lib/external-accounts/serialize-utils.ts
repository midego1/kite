import type { externalAccounts } from "@/db/schema/external-accounts";
import { identityState } from "./identity-code-utils";
import { sendBlock } from "./identity-utils";
import { findPreset } from "./presets-utils";
import type { ExternalAccountView, ExternalIdentityView } from "./types";

/** The parts of an `external_identities` row the account view needs; never the code's hash. */
type IdentityFields = {
	id: string;
	address: string;
	displayName: string | null;
	verifiedAt: Date | null;
	codeHash: string | null;
	codeExpiresAt: Date | null;
};

/** An address of an account as the API returns it: where it stands, never anything about the code but its expiry. */
export function serializeIdentity(row: IdentityFields, accountAddress: string, now = new Date()): ExternalIdentityView {
	const state = identityState(row, now);
	return {
		id: row.id,
		address: row.address,
		displayName: row.displayName,
		accountAddress: row.address === accountAddress,
		state,
		verifiedAt: row.verifiedAt?.toISOString() ?? null,
		codeExpiresAt: state === "pending" ? (row.codeExpiresAt?.toISOString() ?? null) : null,
	};
}

export type ExternalAccountRow = typeof externalAccounts.$inferSelect;

/** The `status_reason` values a sync failure writes (`syncFailureUpdate`). */
const SYNC_PROBLEMS = new Set(["throttled", "transient", "config", "sync"]);

/**
 * The public shape of an account, with when its SMTP sign-in last worked (`readSmtpVerified`) and its addresses that
 * need or have a code (`external_identities`). Fields are listed one by one, so the sealed password (and, later, OAuth
 * tokens or cursors) can never reach a response by being added to the table.
 */
export function serializeExternalAccount(
	row: ExternalAccountRow,
	smtpVerifiedAt: Date | null = null,
	now = new Date(),
	identities: readonly IdentityFields[] = [],
): ExternalAccountView {
	const addressVerified = identities.some((identity) => identity.address === row.address && identity.verifiedAt);
	return {
		id: row.id,
		label: row.label,
		address: row.address,
		displayName: row.displayName,
		preset: row.preset,
		presetLabel: findPreset(row.preset)?.label ?? "IMAP",
		mailboxId: row.mailboxId,
		imap: { host: row.imapHost, port: row.imapPort, security: row.imapSecurity },
		smtp:
			row.smtpHost && row.smtpPort && row.smtpSecurity
				? { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity }
				: null,
		username: row.username,
		status: row.status,
		statusReason: row.statusReason,
		lastError: row.lastError,
		hasPassword: row.secret.length > 0,
		sync: {
			enabled: row.syncEnabled,
			intervalMinutes: row.syncIntervalMinutes,
			lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
			nextSyncAt: row.nextSyncAt?.toISOString() ?? null,
			failures: row.consecutiveFailures,
			problem: SYNC_PROBLEMS.has(row.statusReason ?? "") ? row.statusReason : null,
			running: !!row.leaseUntil && row.leaseUntil.getTime() > now.getTime(),
			junk: row.syncJunk,
		},
		sending: {
			enabled: row.sendEnabled,
			appendSent: row.appendSent,
			providerSavesSent: findPreset(row.preset)?.appendSent === false,
			verified: !!smtpVerifiedAt,
			block: sendBlock({ ...row, hasPassword: row.secret.length > 0, smtpVerifiedAt }, null, addressVerified),
		},
		identities: identities.map((identity) => serializeIdentity(identity, row.address, now)),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
