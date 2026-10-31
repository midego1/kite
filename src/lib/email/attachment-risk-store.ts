import { readAttachmentBytes } from "./attachment-storage";
import {
	assessAttachmentRisk,
	inspectZipDirectory,
	isZipAttachment,
	locateZipDirectory,
	mergeRisks,
	zipDirectoryRefusal,
	ZIP_TAIL_BYTES,
} from "./attachment-risk";
import type { AttachmentRisk } from "./attachment-risk-types";

type StoredAttachment = { id: string; filename: string; contentType: string; size: number; r2Key: string };

async function readRange(
	env: CloudflareEnv,
	attachment: StoredAttachment,
	range: { suffix: number } | { offset: number; length: number },
): Promise<Uint8Array | null> {
	const bytes = await readAttachmentBytes(env, attachment, { range });
	return bytes ? new Uint8Array(bytes) : null;
}

/**
 * Name-based risk plus, for a ZIP, the names inside it: read from its central directory with two bounded range
 * requests (the last 64 KiB, then at most 1 MiB of directory), never extracted. Used before a download.
 */
export async function assessStoredAttachment(
	env: CloudflareEnv,
	attachment: StoredAttachment,
): Promise<AttachmentRisk> {
	const byName = assessAttachmentRisk({ filename: attachment.filename, type: attachment.contentType });
	if (!isZipAttachment({ filename: attachment.filename, type: attachment.contentType }) || attachment.size < 22)
		return byName;
	try {
		const tail = await readRange(env, attachment, { suffix: Math.min(attachment.size, ZIP_TAIL_BYTES) });
		if (!tail) return byName;
		const located = locateZipDirectory(tail);
		if (!located) return mergeRisks(byName, { level: "warning", reasons: ["This archive could not be checked."] });
		const readable =
			!zipDirectoryRefusal(located) && located.size > 0 && located.offset + located.size <= attachment.size;
		const directory = readable
			? await readRange(env, attachment, { offset: located.offset, length: located.size })
			: null;
		return mergeRisks(byName, inspectZipDirectory(located, located.size === 0 ? new Uint8Array(0) : directory));
	} catch {
		return mergeRisks(byName, { level: "warning", reasons: ["This archive could not be checked."] });
	}
}

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Whether a file the route would render inline may skip the gate: only when its name and declared type are clean, so
 * `setup.exe` declared `image/png` is gated and downloaded like any other flagged file (no IO, unlike the ZIP check).
 */
export function servesInline(attachment: { filename: string; contentType: string }, inlineCandidate: boolean): boolean {
	return (
		inlineCandidate &&
		assessAttachmentRisk({ filename: attachment.filename, type: attachment.contentType }).level === "ok"
	);
}

/**
 * The download gate shared by the mail attachment route and Drive's mail attachments: `?risk=1` answers the
 * assessment, and a flagged file answers 409 unless the request carries `?acknowledge=1`, so a link in a message
 * cannot start the download in one click. Only an inline file whose name and type are clean (`servesInline`) skips
 * it. Null means serve the file. A refusal cancels the unread body. `acknowledge=1` guards against accidents; it is
 * not a security boundary, since the user can always add it.
 */
export async function attachmentDownloadGate(
	env: CloudflareEnv,
	request: Request,
	attachment: StoredAttachment,
	object: { body: ReadableStream },
	inline: boolean,
): Promise<Response | null> {
	const params = new URL(request.url).searchParams;
	const riskRequested = params.get("risk") === "1";
	if (servesInline(attachment, inline) && !riskRequested) return null;
	const risk = await assessStoredAttachment(env, attachment);
	if (riskRequested) {
		await object.body.cancel().catch(() => undefined);
		return Response.json(risk, { headers: NO_STORE });
	}
	if (risk.level === "ok" || params.get("acknowledge") === "1") return null;
	await object.body.cancel().catch(() => undefined);
	return Response.json(
		{
			error: "This file is flagged as risky. Review the warning before downloading it.",
			code: "ATTACHMENT_RISK",
			risk,
		},
		{ status: 409, headers: NO_STORE },
	);
}
