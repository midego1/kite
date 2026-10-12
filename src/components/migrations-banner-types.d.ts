export interface PendingMigrationsResponse {
	pending: number;
	/** The pending migration file names; the endpoint sends them only to the primary admin. */
	names?: string[];
}

export interface MigrationApplyResponse {
	applied?: string[];
	/** The safety backup saved just before the migrations ran, when the database held data. */
	backupId?: string | null;
	error?: string;
}
