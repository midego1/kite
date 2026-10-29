export interface PendingMigrationsResponse {
	pending: number;
	/** The pending migration file names; the endpoint sends them only to the primary admin. */
	names?: string[];
	/** The primary admin, who can apply them; the endpoint sends it only to the other admins. */
	appliedBy?: { name: string; email: string };
}

export interface MigrationApplyResponse {
	applied?: string[];
	/** The safety backup saved just before the migrations ran, when the database held data. */
	backupId?: string | null;
	error?: string;
}
