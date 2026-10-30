import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

/**
 * The R2 bucket API over a directory. Objects are files under `root`; the
 * HTTP and custom metadata R2 would keep ride in a `.meta.json` sidecar.
 * Covers what the app uses: get (with a byte range), put (streamed to disk), delete, head,
 * list and multipart uploads (adapted from Mailflare 9f66e13).
 */
type StoredMeta = {
	httpMetadata?: { contentType?: string; contentDisposition?: string; cacheControl?: string };
	customMetadata?: Record<string, string>;
	size: number;
	uploaded: string;
	etag: string;
};

function assertInside(root: string, path: string) {
	const full = resolve(path);
	if (full !== root && !full.startsWith(root + sep)) throw new Error("Object key escapes the bucket root");
	return full;
}

class FileObject {
	constructor(
		readonly key: string,
		private readonly path: string,
		private readonly meta: StoredMeta,
		private readonly range?: { offset: number; length: number },
	) {}

	get size() {
		return this.meta.size;
	}
	get etag() {
		return this.meta.etag;
	}
	get httpEtag() {
		return `"${this.meta.etag}"`;
	}
	get uploaded() {
		return new Date(this.meta.uploaded);
	}
	get httpMetadata() {
		return this.meta.httpMetadata ?? {};
	}
	get customMetadata() {
		return this.meta.customMetadata ?? {};
	}
	get version() {
		return this.meta.etag;
	}
	get body(): ReadableStream<Uint8Array> {
		const options = this.range
			? { start: this.range.offset, end: this.range.offset + this.range.length - 1 }
			: undefined;
		return Readable.toWeb(createReadStream(this.path, options)) as ReadableStream<Uint8Array>;
	}
	get bodyUsed() {
		return false;
	}
	async arrayBuffer(): Promise<ArrayBuffer> {
		const buffer = await readFile(this.path);
		const slice = this.range ? buffer.subarray(this.range.offset, this.range.offset + this.range.length) : buffer;
		return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
	}
	async text(): Promise<string> {
		return Buffer.from(await this.arrayBuffer()).toString("utf8");
	}
	async json<T>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}
	async blob(): Promise<Blob> {
		return new Blob([await this.arrayBuffer()], { type: this.meta.httpMetadata?.contentType });
	}
	writeHttpMetadata(headers: Headers) {
		if (this.meta.httpMetadata?.contentType) headers.set("Content-Type", this.meta.httpMetadata.contentType);
		if (this.meta.httpMetadata?.contentDisposition)
			headers.set("Content-Disposition", this.meta.httpMetadata.contentDisposition);
		if (this.meta.httpMetadata?.cacheControl) headers.set("Cache-Control", this.meta.httpMetadata.cacheControl);
	}
}

export class FileBucket {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private pathFor(key: string) {
		return assertInside(this.root, join(this.root, key));
	}

	private async readMeta(key: string): Promise<StoredMeta | null> {
		try {
			return JSON.parse(await readFile(`${this.pathFor(key)}.meta.json`, "utf8")) as StoredMeta;
		} catch {
			try {
				const info = await stat(this.pathFor(key));
				return { size: info.size, uploaded: info.mtime.toISOString(), etag: String(info.mtimeMs) };
			} catch {
				return null;
			}
		}
	}

	async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
		const meta = await this.readMeta(key);
		if (!meta) return null;
		let range: { offset: number; length: number } | undefined;
		if (options?.range) {
			const offset =
				options.range.suffix != null ? Math.max(meta.size - options.range.suffix, 0) : (options.range.offset ?? 0);
			const length = Math.min(options.range.length ?? meta.size - offset, meta.size - offset);
			range = { offset, length };
		}
		return new FileObject(key, this.pathFor(key), meta, range);
	}

	async head(key: string) {
		const meta = await this.readMeta(key);
		return meta ? new FileObject(key, this.pathFor(key), meta) : null;
	}

	/**
	 * Streams are piped to disk, so a large object is never held in memory; the file appears only once complete.
	 * Like R2, `onlyIf` makes the write conditional on the current etag and a refused write returns null; the check
	 * and the swap run under a per-object lock, so two writers in this process cannot both pass it.
	 */
	async put(key: string, value: BucketValue | null, options?: PutOptions) {
		const path = this.pathFor(key);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.partial`;
		try {
			await pipeline(toReadable(value), createWriteStream(temporary));
			const httpMetadata =
				options?.httpMetadata instanceof Headers
					? { contentType: options.httpMetadata.get("content-type") ?? undefined }
					: options?.httpMetadata;
			return await withObjectLock(path, async () => {
				if (!conditionHolds(options?.onlyIf, (await this.readMeta(key))?.etag ?? null)) {
					await rm(temporary, { force: true });
					return null;
				}
				await rename(temporary, path);
				const { size } = await stat(path);
				return this.writeMeta(key, path, { httpMetadata, customMetadata: options?.customMetadata, size });
			});
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	private async writeMeta(key: string, path: string, meta: Omit<StoredMeta, "uploaded" | "etag">) {
		const stored: StoredMeta = {
			...meta,
			uploaded: new Date().toISOString(),
			// Random, so two writes in the same millisecond never share a version a conditional write could confuse.
			etag: randomUUID().replaceAll("-", ""),
		};
		await writeFile(`${path}.meta.json`, JSON.stringify(stored));
		return new FileObject(key, path, stored);
	}

	async delete(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			const path = this.pathFor(key);
			await rm(path, { force: true });
			await rm(`${path}.meta.json`, { force: true });
		}
	}

	/** Keys in lexical order, as R2 lists them; `cursor` is the last key of the previous page, `startAfter` any key. */
	async list(options?: { prefix?: string; cursor?: string; startAfter?: string; limit?: number }) {
		const prefix = options?.prefix ?? "";
		const limit = Math.min(Math.max(options?.limit ?? 1000, 1), 1000);
		const after = [options?.cursor, options?.startAfter].reduce<string>(
			(latest, key) => (key && key > latest ? key : latest),
			"",
		);
		const keys = (await this.walkKeys(this.root))
			.filter((key) => key.startsWith(prefix) && (!after || key > after))
			.sort();
		const page = keys.slice(0, limit);
		const objects = [];
		for (const key of page) {
			const meta = await this.readMeta(key);
			if (meta) objects.push(new FileObject(key, this.pathFor(key), meta));
		}
		const truncated = keys.length > limit;
		return { objects, truncated, cursor: truncated ? page.at(-1) : undefined, delimitedPrefixes: [] as string[] };
	}

	private async walkKeys(directory: string): Promise<string[]> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return [];
		}
		const keys: string[] = [];
		for (const entry of entries) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (full !== join(this.root, MULTIPART_DIRECTORY)) keys.push(...(await this.walkKeys(full)));
			} else if (!entry.name.endsWith(".meta.json") && !entry.name.endsWith(".partial")) {
				keys.push(relative(this.root, full).split(sep).join("/"));
			}
		}
		return keys;
	}

	private multipartDirectory(uploadId: string) {
		if (!/^[\w-]+$/.test(uploadId)) throw new Error("Invalid multipart upload id");
		return join(this.root, MULTIPART_DIRECTORY, uploadId);
	}

	async createMultipartUpload(key: string, options?: { httpMetadata?: StoredMeta["httpMetadata"] }) {
		this.pathFor(key);
		const uploadId = randomUUID();
		const directory = this.multipartDirectory(uploadId);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "upload.json"), JSON.stringify({ key, httpMetadata: options?.httpMetadata ?? {} }));
		return this.resumeMultipartUpload(key, uploadId);
	}

	/** Parts are files in a per-upload directory; completing concatenates them in part order into the object. */
	resumeMultipartUpload(key: string, uploadId: string) {
		const directory = this.multipartDirectory(uploadId);
		const partPath = (partNumber: number) => join(directory, `part-${partNumber}`);
		const readUpload = async () => {
			const upload = JSON.parse(await readFile(join(directory, "upload.json"), "utf8")) as UploadMeta;
			if (upload.key !== key) throw new Error("The multipart upload belongs to another key");
			return upload;
		};
		return {
			key,
			uploadId,
			uploadPart: async (partNumber: number, value: BucketValue) => {
				if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS)
					throw new Error("Invalid part number");
				await readUpload();
				const temporary = `${partPath(partNumber)}.${randomUUID()}.partial`;
				try {
					await pipeline(toReadable(value), createWriteStream(temporary));
					await rename(temporary, partPath(partNumber));
				} catch (error) {
					await rm(temporary, { force: true });
					throw error;
				}
				const { size } = await stat(partPath(partNumber));
				return { partNumber, etag: partEtag(partNumber, size) };
			},
			abort: async () => {
				await rm(directory, { recursive: true, force: true });
			},
			complete: async (parts: { partNumber: number; etag: string }[]) => {
				const upload = await readUpload();
				const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
				if (!ordered.length) throw new Error("A multipart upload needs at least one part");
				for (const part of ordered) {
					const info = await stat(partPath(part.partNumber)).catch(() => null);
					if (!info || part.etag !== partEtag(part.partNumber, info.size))
						throw new Error(`Invalid part ${part.partNumber}`);
				}
				const path = this.pathFor(key);
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.${randomUUID()}.partial`;
				const out = createWriteStream(temporary);
				try {
					for (const part of ordered) await pipeline(createReadStream(partPath(part.partNumber)), out, { end: false });
					out.end();
					await finished(out);
					await rename(temporary, path);
				} catch (error) {
					out.destroy();
					await rm(temporary, { force: true });
					throw error;
				}
				const { size } = await stat(path);
				const object = await this.writeMeta(key, path, { httpMetadata: upload.httpMetadata, size });
				await rm(directory, { recursive: true, force: true });
				return object;
			},
		};
	}
}

type BucketValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob;
type PutConditional = { etagMatches?: string; etagDoesNotMatch?: string };
type PutOptions = {
	httpMetadata?: StoredMeta["httpMetadata"] | Headers;
	customMetadata?: Record<string, string>;
	onlyIf?: PutConditional;
};

/** Whether a conditional write may go ahead against the object's etag (null when absent); "*" matches any object. */
function conditionHolds(onlyIf: PutConditional | undefined, etag: string | null): boolean {
	if (!onlyIf) return true;
	const matches = (wanted: string) => etag !== null && (wanted === "*" || wanted === etag);
	if (onlyIf.etagMatches !== undefined && !matches(onlyIf.etagMatches)) return false;
	return onlyIf.etagDoesNotMatch === undefined || !matches(onlyIf.etagDoesNotMatch);
}

/** The tail of each object's queue of writes in this process, so a check and the write after it are atomic. */
const objectLocks = new Map<string, Promise<unknown>>();

async function withObjectLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	const previous = objectLocks.get(path) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(run);
	objectLocks.set(path, current);
	try {
		return await current;
	} finally {
		if (objectLocks.get(path) === current) objectLocks.delete(path);
	}
}
type UploadMeta = { key: string; httpMetadata?: StoredMeta["httpMetadata"] };

const MULTIPART_DIRECTORY = ".multipart";
const MAX_PARTS = 10_000;

function partEtag(partNumber: number, size: number): string {
	return `${partNumber}-${size.toString(16)}`;
}

function toReadable(value: BucketValue | null): Readable {
	if (value === null) return Readable.from([]);
	if (typeof value === "string") return Readable.from([Buffer.from(value)]);
	if (value instanceof ArrayBuffer) return Readable.from([Buffer.from(value)]);
	if (ArrayBuffer.isView(value)) return Readable.from([Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
	if (value instanceof Blob) return Readable.fromWeb(value.stream() as never);
	return Readable.fromWeb(value as never);
}

export function openFileBucket(root: string): R2Bucket {
	return new FileBucket(root) as unknown as R2Bucket;
}
