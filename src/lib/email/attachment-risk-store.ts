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

async function readRange(
	env: CloudflareEnv,
	key: string,
	range: { suffix: number } | { offset: number; length: number },
): Promise<Uint8Array | null> {
	const object = await env.BUCKET.get(key, { range });
	return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/**
 * Name-based risk plus, for a ZIP, the names inside it: read from its central directory with two bounded range
 * requests (the last 64 KiB, then at most 1 MiB of directory), never extracted. Used before a download.
 */
export async function assessStoredAttachment(
	env: CloudflareEnv,
	attachment: { filename: string; contentType: string; size: number; r2Key: string },
): Promise<AttachmentRisk> {
	const byName = assessAttachmentRisk({ filename: attachment.filename, type: attachment.contentType });
	if (!isZipAttachment({ filename: attachment.filename, type: attachment.contentType }) || attachment.size < 22)
		return byName;
	try {
		const tail = await readRange(env, attachment.r2Key, { suffix: Math.min(attachment.size, ZIP_TAIL_BYTES) });
		if (!tail) return byName;
		const located = locateZipDirectory(tail);
		if (!located) return mergeRisks(byName, { level: "warning", reasons: ["This archive could not be checked."] });
		const readable =
			!zipDirectoryRefusal(located) && located.size > 0 && located.offset + located.size <= attachment.size;
		const directory = readable
			? await readRange(env, attachment.r2Key, { offset: located.offset, length: located.size })
			: null;
		return mergeRisks(byName, inspectZipDirectory(located, located.size === 0 ? new Uint8Array(0) : directory));
	} catch {
		return mergeRisks(byName, { level: "warning", reasons: ["This archive could not be checked."] });
	}
}

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The download gate shared by the mail attachment route and Drive's mail attachments: `?risk=1` answers the
 * assessment, and a flagged file that is not shown inline answers 409 unless the request carries `?acknowledge=1`,
 * so a direct link cannot skip the warning. Null means serve the file. A refusal cancels the unread body.
 */
export async function attachmentDownloadGate(
	env: CloudflareEnv,
	request: Request,
	attachment: { filename: string; contentType: string; size: number; r2Key: string },
	object: { body: ReadableStream },
	inline: boolean,
): Promise<Response | null> {
	const params = new URL(request.url).searchParams;
	const riskRequested = params.get("risk") === "1";
	if (inline && !riskRequested) return null;
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
