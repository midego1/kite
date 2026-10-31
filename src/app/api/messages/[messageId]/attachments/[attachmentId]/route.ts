import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getAttachmentForUser } from "@/lib/email/attachments";
import { getDownloadContentType, getInlineContentType } from "@/lib/http/content-type-utils";
import type { AttachmentRouteParams } from "./types";
import { getContentDisposition } from "@/lib/http/content-disposition-utils";

export async function GET(request: Request, { params }: AttachmentRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return new Response("Not found", { status: 404 });

	const { attachment, object } = result;
	const url = new URL(request.url);
	const previewRequested = url.searchParams.get("preview") === "1";
	const downloadRequested = url.searchParams.get("download") === "1";
	// The sender picks both the type and the disposition, so only types that cannot run script ever render inline.
	// The sandbox policy below is a second layer, not the guard: on the Node runtime the global API policy from
	// next.config may be what the browser sees.
	const inlineType = downloadRequested ? null : getInlineContentType(attachment.contentType);
	const inline = inlineType !== null && (attachment.disposition === "inline" || previewRequested);
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Type", inline && inlineType ? inlineType : getDownloadContentType(attachment.contentType));
	headers.set("Content-Length", String(attachment.size));
	headers.set("Content-Disposition", getContentDisposition(attachment.filename, inline));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Content-Security-Policy",
		"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
	);
	headers.set("Cache-Control", "private, max-age=3600");

	return new Response(object.body, { headers });
}
