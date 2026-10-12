/**
 * A manual backup to run on the outbound queue. The export must not run inside
 * the admin request: on a large database it outlives the platform's response
 * timeout, the invocation is cancelled mid-export, and the record would stay
 * "running" forever because the runner's own catch block never executes.
 */
export type BackupRunMessage = { kind: "backup.run"; backupId: string };
