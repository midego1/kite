import type { RestoreJob } from "./restore-job-types";
import { RESTORE_JOB_KEY } from "./restore-job-utils";

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
 * Writes the job only when it is still the version read as `etag` (R2 conditional put; the self-hosted file
 * bucket runs in one process and ignores the condition). Returns the new version.
 */
export async function writeRestoreJob(bucket: R2Bucket, job: RestoreJob, etag: string | null): Promise<string> {
	const written = await bucket.put(RESTORE_JOB_KEY, JSON.stringify(job), {
		httpMetadata: { contentType: "application/json" },
		...(etag ? { onlyIf: { etagMatches: etag } } : {}),
	});
	if (!written) throw new RestoreLeaseLostError();
	return written.etag;
}
