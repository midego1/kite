import type { externalAccounts } from "@/db/schema/external-accounts";
import { findPreset } from "./presets-utils";
import type { ExternalAccountView } from "./types";

export type ExternalAccountRow = typeof externalAccounts.$inferSelect;

/** The `status_reason` values a sync failure writes (`syncFailureUpdate`). */
const SYNC_PROBLEMS = new Set(["throttled", "transient", "config", "sync"]);

/**
 * The public shape of an account. Fields are listed one by one, so the sealed password (and, later, OAuth tokens or
 * cursors) can never reach a response by being added to the table.
 */
export function serializeExternalAccount(row: ExternalAccountRow, now = new Date()): ExternalAccountView {
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
		},
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The last 20 problems of an account, newest last, as stored in `recent_errors`. */
export function appendRecentError(stored: string, message: string, at: Date): string {
	let list: { at: string; message: string }[] = [];
	try {
		const parsed = JSON.parse(stored) as unknown;
		if (Array.isArray(parsed))
			list = parsed.filter(
				(entry): entry is { at: string; message: string } =>
					!!entry && typeof entry.at === "string" && typeof entry.message === "string",
			);
	} catch {
		list = [];
	}
	return JSON.stringify([...list, { at: at.toISOString(), message }].slice(-20));
}
