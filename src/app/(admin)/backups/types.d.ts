import type { BackupTableGroupId } from "@/lib/backups/types";

export type BackupScheduleType = "daily" | "weekly" | "monthly";
export type BackupStatus = "queued" | "running" | "completed" | "failed";

export type BackupSettings = {
	id: string;
	enabled: boolean;
	scheduleType: BackupScheduleType;
	scheduleValue: number | null;
	retentionEnabled: boolean;
	retentionDays: number;
	excludedTableGroups: BackupTableGroupId[];
	/** Copy the mail files (raw MIME, attachments, offloaded bodies) with every backup. */
	includeObjects: boolean;
	updatedAt: string;
};

export type BackupObjectsStatus = "pending" | "copying" | "completed" | "failed" | "restoring";

export type BackupItem = {
	id: string;
	status: BackupStatus;
	trigger: "manual" | "scheduled" | "pre-restore" | "pre-migration";
	filename: string | null;
	size: number | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	objectsStatus: BackupObjectsStatus | null;
	objectsCount: number | null;
	objectsSize: number | null;
	objectsMissing: number | null;
	objectsFailed: number | null;
	/** JSON `BackupObjectsRestoreResult` of the last restore of the mail files. */
	objectsRestore: string | null;
};

export type BackupsResponse = {
	settings: BackupSettings;
	backups: BackupItem[];
	configuration: {
		configured: boolean;
		missing: string[];
	};
};
