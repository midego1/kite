import type { externalAccounts } from "@/db/schema/external-accounts";
import { sendBlock } from "./identity-utils";
import { findPreset } from "./presets-utils";
import type { ExternalAccountView } from "./types";

export type ExternalAccountRow = typeof externalAccounts.$inferSelect;

/** The `status_reason` values a sync failure writes (`syncFailureUpdate`). */
const SYNC_PROBLEMS = new Set(["throttled", "transient", "config", "sync"]);

/**
 * The public shape of an account, with when its SMTP sign-in last worked (`readSmtpVerified`). Fields are listed one by one, so the sealed password (and, later, OAuth tokens or
 * cursors) can never reach a response by being added to the table.
 */
export function serializeExternalAccount(
	row: ExternalAccountRow,
	smtpVerifiedAt: Date | null = null,
	now = new Date(),
): ExternalAccountView {
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
			block: sendBlock({ ...row, hasPassword: row.secret.length > 0, smtpVerifiedAt }, null),
		},
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
