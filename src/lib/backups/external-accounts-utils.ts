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
