import type { KiteBucket } from "./types";

/** Probe objects live under `healthcheck/`, which is a `system` key, so the router never sends one elsewhere. */
export function probeKey(label = "probe"): string {
	return `healthcheck/kite-${label}-${crypto.randomUUID()}`;
}

export type StorageTestStep = "write" | "read" | "delete";

export class StorageTestError extends Error {
	constructor(
		readonly step: StorageTestStep,
		readonly cause: unknown,
	) {
		super(`Storage ${step} failed`);
	}
}

/**
 * Writes, reads back and deletes a small probe object; ported from Mailflare 83ade98 `testStorage`. With
 * `keep`, the probe stays for the caller (validation signs a link to it) and the caller deletes it.
 */
export async function testStorage(
	bucket: Pick<KiteBucket, "put" | "get" | "delete">,
	options: { key?: string; keep?: boolean } = {},
): Promise<{ key: string; deleted: boolean }> {
	const key = options.key ?? probeKey();
	const body = `kite storage check ${new Date().toISOString()}`;
	try {
		await bucket.put(key, body, { httpMetadata: { contentType: "text/plain" } });
	} catch (error) {
		throw new StorageTestError("write", error);
	}
	try {
		const object = await bucket.get(key);
		if (!object || (await object.text()) !== body) throw new Error("The test object came back different");
	} catch (error) {
		await bucket.delete(key).catch(() => undefined);
		throw new StorageTestError("read", error);
	}
	if (options.keep) return { key, deleted: false };
	try {
		await bucket.delete(key);
	} catch (error) {
		throw new StorageTestError("delete", error);
	}
	return { key, deleted: true };
}
