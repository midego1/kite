import { getEnv } from "@/lib/cloudflare";
import { getContentDisposition } from "@/lib/http/content-disposition-utils";
import { findSharedFile } from "@/lib/email/shared-attachments";
import type { SharedFileParams } from "./types";

export async function GET(_request: Request, { params }: SharedFileParams) {
	const { id } = await params;
	const env = getEnv();
	const file = await findSharedFile(env, id);
	if (!file) return new Response("Link expired or not found", { status: 404 });
	const object = await env.BUCKET.get(file.r2Key);
	if (!object) return new Response("File not found", { status: 404 });
	const headers = new Headers();
	// Anyone with the link gets opaque bytes to save, never a type a browser would render or run.
	headers.set("Content-Type", "application/octet-stream");
	headers.set("Content-Length", String(file.size));
	headers.set("Content-Disposition", getContentDisposition(file.filename, false));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Cache-Control", "private, no-store");
	return new Response(object.body, { headers });
}
