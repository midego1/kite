import { chunkArray } from "@/db/chunk-utils";
import { getContentDisposition } from "@/lib/http/content-disposition-utils";
import { createLogger } from "@/lib/logger.mjs";
import { createZipStream, zipArchiveBytes } from "@/lib/zip/zip-stream-utils";
import type { ZipEntrySource } from "@/lib/zip/zip-stream-types";
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
	const names = uniqueZipEntryNames(attachments.map((row) => row.filename));
	if (zipArchiveBytes(attachments.map((row, index) => ({ name: names[index], size: row.size }))) === null)
		return refusal(413, { error: "These attachments are too large to download as one archive.", code: "TOO_LARGE" });

	const stored = await inBatches(attachments, (row) => isAttachmentStored(env, row));
	const missing = attachments.filter((_, index) => !stored[index]);
	if (missing.length)
		return refusal(404, {
			error: "Some attachments are missing from storage.",
			code: "ATTACHMENT_MISSING",
			missing: missing.map((row) => ({ id: row.id, filename: row.filename })),
		});

	if (acknowledged) return null;
	const risks = await inBatches(attachments, (row) => assessStoredAttachment(env, row));
	const flagged = attachments
		.map((row, index) => ({ id: row.id, filename: row.filename, risk: risks[index] }))
		.filter((entry) => entry.risk.level !== "ok");
	if (!flagged.length) return null;
	return refusal(409, {
		error: "Some attachments are flagged as risky. Review the warning before downloading them.",
		code: "ATTACHMENT_RISK",
		flagged,
	});
}

/**
 * The archive of `attachments` as a streamed download named after `subject`. Each file is opened from its current row
 * when the archive reaches it; one that went missing since the check aborts the download instead of being left out.
 */
export function attachmentArchiveResponse(
	env: CloudflareEnv,
	messageId: string,
	subject: string | null,
	attachments: readonly AttachmentRow[],
): Response {
	const names = uniqueZipEntryNames(attachments.map((row) => row.filename));
	const entries: ZipEntrySource[] = attachments.map((row, index) => ({
		name: names[index],
		modified: row.createdAt,
		open: async () => {
			const opened = await openMessageAttachment(env, messageId, row.id);
			if (opened) return opened.body;
			log.warn("attachment.archive_entry_missing", { messageId, attachmentId: row.id });
			throw new Error("An attachment went missing while the archive was written");
		},
	}));
	return new Response(createZipStream(entries), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": getContentDisposition(attachmentsArchiveName(subject), false),
			"X-Content-Type-Options": "nosniff",
			...NO_STORE,
		},
	});
}
