import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { listImapFolders } from "@/lib/import/imap";
import type { ImapFolderListRequest } from "./types";
import { parseImapFolderListRequest } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	let input: ReturnType<typeof parseImapFolderListRequest>;
	try {
		const body = await readJsonBody<ImapFolderListRequest>(request, 16 * 1024);
		input = parseImapFolderListRequest(body);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Invalid IMAP folder request" },
			{ status },
		);
	}

	try {
		const folders = await listImapFolders(input);
		return NextResponse.json({ folders });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unable to list IMAP folders" },
			{ status: 502 },
		);
	}
}
