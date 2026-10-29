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

/** The account that can apply pending migrations, named to the other admins. */
export interface MigrationApplier {
	name: string;
	email: string;
}

/**
 * What the mailbox banner's status check answers; names are only sent to the
 * primary admin, and the primary admin's name and address only to other admins.
 */
export interface PendingMigrationStatus {
	pending: number;
	names?: string[];
	appliedBy?: MigrationApplier;
}
