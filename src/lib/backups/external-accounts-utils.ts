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
 * `messages.external_account_id` (mail group) points at `external_accounts` (accounts group). A restore inserts both
 * from the same document, but the message rows may name an account the document does not hold: one connected while
 * the backup was being read (tables are read one after the other), or a document whose accounts were left out. Such
 * a message is restored without its account, as removing the account would have left it (spec §6.7), so the restore
 * never fails on the foreign key and the mail stays.
 */
export function detachMissingExternalAccounts<T extends { name: string; rows: DatabaseRecord[] }>(tables: T[]): T[] {
	const accounts = tables.find((table) => table.name === "external_accounts");
	const known = new Set((accounts?.rows ?? []).map((row) => row.id));
	return tables.map((table) =>
		table.name !== "messages"
			? table
			: {
					...table,
					rows: table.rows.map((row) =>
						row.external_account_id != null && !known.has(row.external_account_id)
							? { ...row, external_account_id: null }
							: row,
					),
				},
	);
}
