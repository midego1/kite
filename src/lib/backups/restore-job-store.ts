import type { RestoreJob } from "./restore-job-types";
import { isActiveRestore, RESTORE_JOB_KEY } from "./restore-job-utils";

/** Another invocation changed the job since it was read, so this one must stop writing. */
export class RestoreLeaseLostError extends Error {
	constructor() {
		super("Another worker took over this restore");
	}
}

type StoredRestoreJob = { job: RestoreJob; etag: string };

export async function readRestoreJob(bucket: R2Bucket): Promise<StoredRestoreJob | null> {
	const object = await bucket.get(RESTORE_JOB_KEY);
	if (!object || !("arrayBuffer" in object)) return null;
	try {
		return { job: JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as RestoreJob, etag: object.etag };
	} catch {
		return null;
	}
}

/**
 * Writes the job only when it is still the version read as `etag`, or, with a null `etag`, only when there is no
 * job yet (R2 conditional puts; the self-hosted file bucket checks the same under a lock). Returns the new version.
 */
export async function writeRestoreJob(bucket: R2Bucket, job: RestoreJob, etag: string | null): Promise<string> {
	const written = await bucket.put(RESTORE_JOB_KEY, JSON.stringify(job), {
		httpMetadata: { contentType: "application/json" },
		onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
	});
	if (!written) throw new RestoreLeaseLostError();
	return written.etag;
}

/**
 * Whether database migrations must wait: a restore (or a recovery) is running, and a schema that changes under
 * it would no longer match its plan. Automatic and manual migrations both check this.
 */
export async function restoreBlocksMigrations(bucket: R2Bucket): Promise<boolean> {
	const stored = await readRestoreJob(bucket);
	return !!stored && isActiveRestore(stored.job);
}
