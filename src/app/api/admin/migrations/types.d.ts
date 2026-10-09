import type { MigrationResult, MigrationStatus } from "@/lib/migrations/types";

export interface MigrationStatusResponse extends MigrationStatus {
	error?: string;
}

export interface MigrationApplyResponse extends MigrationResult {
	error?: string;
	/** The backup saved just before the migrations ran, when the database held data. */
	backupId?: string | null;
}
