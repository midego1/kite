import type { BackupRunMessage } from "./queue-types";

/** The queue body that asks the consumer to export the database for `backupId`. */
export function backupRunMessage(backupId: string): BackupRunMessage {
	return { kind: "backup.run", backupId };
}

export function isBackupRunMessage(payload: unknown): payload is BackupRunMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "backup.run" &&
		typeof (payload as { backupId?: unknown }).backupId === "string"
	);
}
