/**
 * Proxied parts go through the Worker, so they stay under the 100 MB request limit of the Free and Pro plans.
 * Direct parts (phase 2) go straight to the store and can be larger.
 */
export const DRIVE_PROXIED_PART_BYTES = 32 * 1024 * 1024;
/** @public Exercised by the bundled unit tests. */
export const DRIVE_MAX_PARTS = 10_000;
/** How long an interrupted upload can be resumed before the daily job aborts it. */
export const DRIVE_UPLOAD_RESUME_MS = 3 * 24 * 60 * 60 * 1000;
export const DRIVE_MAX_UPLOADS_IN_PROGRESS = 20;
const MAX_FINGERPRINT_LENGTH = 200;
const MAX_CONTENT_TYPE_LENGTH = 200;

export type UploadRequest = {
	name: unknown;
	size: number;
	contentType: string;
	parentId: string | null;
	fingerprint: string;
};

/** The number of parts a file of `size` bytes is sent in; a 0-byte file has none and is stored with one put. */
export function partCount(size: number, partSize: number): number {
	return size === 0 ? 0 : Math.ceil(size / partSize);
}

/** The exact length part `partNumber` (1-based) must have: every part is full size except the last. */
export function expectedPartSize(size: number, partSize: number, partNumber: number): number | null {
	const parts = partCount(size, partSize);
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > parts) return null;
	return partNumber < parts ? partSize : size - partSize * (parts - 1);
}

/** @public Exercised by the bundled unit tests. */
export function maxFileBytes(partSize: number): number {
	return partSize * DRIVE_MAX_PARTS;
}

/** The parsed body of `POST /api/drive/uploads`, or the error to answer with 400. */
export function parseUploadRequest(body: unknown, partSize: number): UploadRequest | { error: string } {
	if (!body || typeof body !== "object") return { error: "Invalid upload" };
	const value = body as Record<string, unknown>;
	const size = value.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return { error: "Invalid file size" };
	if (size > maxFileBytes(partSize)) return { error: "File is too large" };
	const parentId = value.parentId ?? null;
	if (parentId !== null && typeof parentId !== "string") return { error: "Invalid folder" };
	const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint.slice(0, MAX_FINGERPRINT_LENGTH) : "";
	return {
		name: value.name,
		size,
		contentType: normalizeUploadContentType(value.contentType),
		parentId: parentId || null,
		fingerprint,
	};
}

/** The type the browser reported, lower-cased; anything empty or odd is stored as octet-stream. */
export function normalizeUploadContentType(value: unknown): string {
	if (typeof value !== "string") return "application/octet-stream";
	const type = value.trim().toLowerCase();
	return type && type.length <= MAX_CONTENT_TYPE_LENGTH && /^[\x21-\x7e][\x20-\x7e]*$/.test(type)
		? type
		: "application/octet-stream";
}

/** Part numbers as recorded, and whether they are exactly 1..parts (what completing needs). */
export function partsComplete(recorded: number[], parts: number): boolean {
	if (recorded.length !== parts) return false;
	const sorted = [...recorded].sort((a, b) => a - b);
	return sorted.every((number, index) => number === index + 1);
}
