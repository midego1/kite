export interface MigrationStatusResponse {
	applied?: string[];
	/** The safety backup saved just before the migrations ran, when the database held data. */
	backupId?: string | null;
	error?: string;
	pending: string[];
	ready: boolean;
	unknown: string[];
}
