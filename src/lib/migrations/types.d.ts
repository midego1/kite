export interface BundledMigration {
	name: string;
	statements: string[];
}

export interface MigrationStatus {
	ready: boolean;
	pending: string[];
	unknown: string[];
}

export interface MigrationResult extends MigrationStatus {
	applied: string[];
}

export interface MigrationNameRow {
	name: string;
}

/** What the mailbox banner's status check answers; names are only sent to the primary admin. */
export interface PendingMigrationStatus {
	pending: number;
	names?: string[];
}
