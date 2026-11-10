import { newId } from "@/lib/ids";
import { fail } from "./errors";
import type { DriveAnswer } from "./types";
import { WEBDAV_LIMITS } from "./webdav-client";

/** Matches the 20 uploads Drive's own storage allows one account at a time. */
const MAX_MOUNT_UPLOADS_PER_USER = 20;

/** Leases outlive the longest upload deadline by a minute, so a crashed request frees its slot soon after. */
function leaseSeconds(size: number): number {
	const uploadMs = WEBDAV_LIMITS.timeoutMs + (size / WEBDAV_LIMITS.minUploadBytesPerSecond) * 1000;
	return Math.ceil(uploadMs / 1000) + 60;
}

/**
 * Runs an upload to a linked folder while holding one of the user's `MAX_MOUNT_UPLOADS_PER_USER` slots. The count
 * and the insert are one statement, so concurrent requests on any isolate cannot overshoot it. Without a free
 * slot it answers 429 without running `upload`.
 */
export async function withMountUploadSlot(
	env: CloudflareEnv,
	ownerId: string,
	size: number,
	upload: () => Promise<DriveAnswer>,
): Promise<DriveAnswer> {
	const now = Math.floor(Date.now() / 1000);
	const id = newId("dmu");
	await env.DB.prepare("DELETE FROM drive_mount_uploads WHERE owner_id = ? AND expires_at <= ?")
		.bind(ownerId, now)
		.run();
	const result = await env.DB.prepare(
		`INSERT INTO drive_mount_uploads (id, owner_id, expires_at)
		SELECT ?, ?, ? WHERE (SELECT count(*) FROM drive_mount_uploads WHERE owner_id = ? AND expires_at > ?) < ?`,
	)
		.bind(id, ownerId, now + leaseSeconds(size), ownerId, now, MAX_MOUNT_UPLOADS_PER_USER)
		.run();
	if (!(result.meta.changes ?? 0))
		return fail(429, "Too many uploads to linked folders in progress; wait for some to finish", "TOO_MANY_UPLOADS");
	try {
		return await upload();
	} finally {
		await env.DB.prepare("DELETE FROM drive_mount_uploads WHERE id = ?")
			.bind(id)
			.run()
			.catch(() => undefined);
	}
}
