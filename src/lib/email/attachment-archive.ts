import { chunkArray } from "@/db/chunk-utils";
import { getContentDisposition } from "@/lib/http/content-disposition-utils";
import { createLogger } from "@/lib/logger.mjs";
import { createZipStream, zipArchiveBytes } from "@/lib/zip/zip-stream-utils";
import type { ZipEntrySource } from "@/lib/zip/zip-stream-types";
import { stripHiddenCharacters } from "./attachment-risk";
import { assessStoredAttachment } from "./attachment-risk-store";
import { isAttachmentStored } from "./attachment-storage";
import { attachmentsArchiveName, uniqueZipEntryNames } from "./attachment-zip-utils";
import { openMessageAttachment } from "./attachments";
import type { AttachmentRow } from "./attachment-storage-types";

const log = createLogger("attachments");
const NO_STORE = { "Cache-Control": "private, no-store" };
/** Storage checks run a few at a time, so a message with many attachments does not open them all at once. */
const CHECK_BATCH = 4;

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (const batch of chunkArray(items, CHECK_BATCH)) results.push(...(await Promise.all(batch.map(run))));
	return results;
}

/** The archive's entries: each file's safe, unique name inside it and its stored size. */
function archiveEntries(attachments: readonly AttachmentRow[]) {
	const names = uniqueZipEntryNames(attachments.map((row) => row.filename));
	return attachments.map((row, index) => ({ row, name: names[index], size: row.size }));
}

function refusal(status: number, body: Record<string, unknown>): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Checks a message's attachments before they are zipped, in the order a download would fail: too large for a plain ZIP
 * (413), any file missing from storage (404 `ATTACHMENT_MISSING`, rather than an archive that silently leaves it
 * out), then any file the single download would gate (409 `ATTACHMENT_RISK` listing each with its reasons, until the
 * request carries `acknowledge=1`, as `attachmentDownloadGate` does). Null means the archive may be streamed.
 */
export async function attachmentArchiveRefusal(
	env: CloudflareEnv,
	attachments: readonly AttachmentRow[],
	acknowledged: boolean,
): Promise<Response | null> {
	// Files are named as they will be in the archive, so an older row's bidi override cannot disguise a name here.
	const entries = archiveEntries(attachments);
	if (zipArchiveBytes(entries) === null)
		return refusal(413, { error: "These attachments are too large to download as one archive.", code: "TOO_LARGE" });

	const stored = await inBatches(entries, (entry) => isAttachmentStored(env, entry.row));
	const missing = entries.filter((_, index) => !stored[index]);
	if (missing.length)
		return refusal(404, {
			error: "Some attachments are missing from storage.",
			code: "ATTACHMENT_MISSING",
			missing: missing.map((entry) => ({ id: entry.row.id, filename: entry.name })),
		});

	if (acknowledged) return null;
	const risks = await inBatches(entries, (entry) => assessStoredAttachment(env, entry.row));
	const flagged = entries
		.map((entry, index) => ({
			id: entry.row.id,
			filename: entry.name,
			risk: { ...risks[index], reasons: risks[index].reasons.map(stripHiddenCharacters) },
		}))
		.filter((entry) => entry.risk.level !== "ok");
	if (!flagged.length) return null;
	return refusal(409, {
		error: "Some attachments are flagged as risky. Review the warning before downloading them.",
		code: "ATTACHMENT_RISK",
		flagged,
	});
}

/**
 * `stream` with its exact length: on Workers through a `FixedLengthStream`, without which the Content-Length header
 * is dropped for a streamed body (it also errors the response if the count is off); Node sends the header as it is.
 */
function withLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
	if (typeof FixedLengthStream !== "function") return stream;
	return stream.pipeThrough(new FixedLengthStream(length) as unknown as TransformStream<Uint8Array, Uint8Array>);
}

/**
 * The archive of `attachments` as a streamed download named after `subject`, with its exact Content-Length. Each file is
 * opened from its current row when the archive reaches it; one that went missing since the check, or whose content is
 * not its stored size, aborts the download instead of being left out or cut short.
 */
export function attachmentArchiveResponse(
	env: CloudflareEnv,
	messageId: string,
	subject: string | null,
	attachments: readonly AttachmentRow[],
): Response {
	const planned = archiveEntries(attachments);
	const length = zipArchiveBytes(planned);
	if (length === null) throw new Error("The attachments are too large for one archive");
	const entries: ZipEntrySource[] = planned.map(({ row, name, size }) => ({
		name,
		size,
		modified: row.createdAt,
		open: async () => {
			const opened = await openMessageAttachment(env, messageId, row.id);
			if (opened && opened.size === size) return opened.body;
			await opened?.body.cancel().catch(() => undefined);
			log.warn(opened ? "attachment.archive_entry_size_mismatch" : "attachment.archive_entry_missing", {
				messageId,
				attachmentId: row.id,
			});
			throw new Error("An attachment went missing or changed while the archive was written");
		},
	}));
	return new Response(withLength(createZipStream(entries), length), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Length": String(length),
			"Content-Disposition": getContentDisposition(attachmentsArchiveName(subject), false),
			"X-Content-Type-Options": "nosniff",
			...NO_STORE,
		},
	});
}
