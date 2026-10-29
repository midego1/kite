import type { DatabaseRecord } from "./types";

/** The columns of `external_accounts` a backup never carries: the sealed password (and, later, OAuth tokens). */
const SECRET_COLUMNS = ["secret", "oauth_refresh_token", "oauth_access_token"];

/**
 * A backup document travels (downloads, the Backups store), so connected accounts leave it without their passwords
 * (spec §10.2, decision 6): the row, its settings and its sync positions stay, the secret is empty.
 */
export function redactBackupRow(table: string, row: DatabaseRecord): DatabaseRecord {
	if (table !== "external_accounts") return row;
	const redacted: DatabaseRecord = { ...row };
	for (const column of SECRET_COLUMNS) if (column in redacted) redacted[column] = column === "secret" ? "" : null;
	return redacted;
}

/** A restored connected account has no password, so it waits for its owner to reconnect it. */
export function restoredBackupRow(table: string, row: DatabaseRecord): DatabaseRecord {
	if (table !== "external_accounts") return row;
	return {
		...redactBackupRow(table, row),
		status: "auth_failed",
		status_reason: "restored",
		last_error: "Reconnect after restore",
		lease_until: null,
	};
}

/**
 * A restored message row, as far as its connected account goes. `messages.external_account_id` (mail group) points at
 * `external_accounts` (accounts group). A restore inserts both from the same document, but a message may name an
 * account the document does not hold: one connected while the backup was being read (tables are read one after the
 * other), or a document whose accounts were left out. Such a message is restored without its account, as removing the
 * account would have left it (spec §6.7), so the restore never fails on the foreign key and the mail stays.
 * `accountIds` are the accounts the backup restores; null (a restore prepared before this was recorded) keeps the row.
 */
export function detachMissingExternalAccount(
	table: string,
	row: DatabaseRecord,
	accountIds: ReadonlySet<string> | null,
): DatabaseRecord {
	if (table !== "messages" || !accountIds) return row;
	const accountId = row.external_account_id;
	return accountId != null && !accountIds.has(String(accountId)) ? { ...row, external_account_id: null } : row;
}
