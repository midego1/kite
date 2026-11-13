import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { attachmentArchiveRefusal, attachmentArchiveResponse } from "@/lib/email/attachment-archive";
import { findMessageAttachmentsForUser } from "@/lib/email/attachments";
import type { AttachmentsZipRouteParams } from "./types";

/**
 * Every attachment of a message as one streamed ZIP ("Download all"), for anyone who may read the message.
 * `?check=1` runs the same checks and answers `{ count }` instead of the archive, so the reader can confirm first;
 * `?acknowledge=1` downloads flagged files, as on the single attachment route.
 */
export async function GET(request: Request, { params }: AttachmentsZipRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const { messageId } = await params;
	const found = await findMessageAttachmentsForUser(env, user, messageId);
	if (!found?.attachments.length) return Response.json({ error: "Not found" }, { status: 404 });

	const search = new URL(request.url).searchParams;
	const refused = await attachmentArchiveRefusal(env, found.attachments, search.get("acknowledge") === "1");
	if (refused) return refused;
	if (search.get("check") === "1")
		return Response.json({ count: found.attachments.length }, { headers: { "Cache-Control": "private, no-store" } });
	return attachmentArchiveResponse(env, messageId, found.subject, found.attachments);
}
