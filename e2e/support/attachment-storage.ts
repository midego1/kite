import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

// The attachment storage report and jobs (docs/specs/attachments-once.md) as e2e/21-attachment-storage.spec.ts and
// e2e/10-backups.spec.ts use them.

export type Attachment = { id: string; filename: string; size: number };
export type Verification = { checked: number; missing: { key: string; messageIds: string[] }[] };
export type StorageJob = {
	id: string;
	direction: string;
	status: string;
	done: number;
	converted: number;
	unshared: number;
};
export type StorageReport = {
	objects: { rows: number; keys: number; bytes: number; storedBytes: number };
	raw: { rows: number; bytes: number };
	shared: { keys: number; rows: number };
	reclaim: { pending: { rows: number; bytes: number }; unmatched: { rows: number } } | null;
	job: StorageJob | null;
};

/** A 2×2 PNG, so the reader has a real image to decode. */
export const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGNQTX79//9/hv///6smvwYAPKII4TwRI+AAAAAASUVORK5CYII=",
	"base64",
);

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A PDF-looking file with random content, so a byte-exact comparison means something. */
export function pdfFixture(): Buffer {
	return Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(48 * 1024), Buffer.from("\n%%EOF\n")]);
}

export async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()}: ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

export async function attachmentsOf(api: APIRequestContext, messageId: string): Promise<Attachment[]> {
	return (await json<{ attachments: Attachment[] }>(await api.get(`/api/messages/${messageId}`))).attachments;
}

export async function download(api: APIRequestContext, messageId: string, attachmentId: string): Promise<Buffer> {
	const response = await api.get(`/api/messages/${messageId}/attachments/${attachmentId}?download=1`);
	expect(response.status(), response.url()).toBe(200);
	return response.body();
}

export async function storageCounts(api: APIRequestContext): Promise<StorageReport> {
	return json<StorageReport>(await api.get("/api/admin/attachment-storage"));
}

export async function verifyObjects(api: APIRequestContext): Promise<Verification> {
	return (await json<{ verify: Verification }>(await api.get("/api/admin/attachment-storage?verify=1"))).verify;
}

async function waitForJob(api: APIRequestContext, jobId: string): Promise<StorageJob> {
	let job: StorageJob | null = null;
	await expect
		.poll(
			async () => {
				job = (await storageCounts(api)).job;
				return job?.id === jobId ? job.status : "missing";
			},
			{ timeout: 60_000, intervals: [250, 500, 1000] },
		)
		.toBe("completed");
	return job!;
}

/** Starts a storage job through the API and waits until it has finished. */
export async function runJob(api: APIRequestContext, action: "reclaim" | "materialize"): Promise<StorageJob> {
	const started = await json<{ job: StorageJob }>(
		await api.post("/api/admin/attachment-storage", { data: { action } }),
	);
	return waitForJob(api, started.job.id);
}
