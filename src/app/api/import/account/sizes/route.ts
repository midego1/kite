import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { measureFolderStep } from "@/lib/import/folder-sizes";
import { parseSizeCursor, sizeProgress } from "@/lib/import/folder-size-utils";
import { importServerProblem } from "@/lib/import/imap";
import { withModule } from "@/lib/modules/route-guard";
import { resolveImportSource } from "../../connected-account";
import type { ImapFolderListRequest } from "../../imap/folders/types";
import { parseImapFolderListRequest } from "../../imap/folders/utils";

type SizesRequest = ImapFolderListRequest & { accountId?: unknown; folder?: unknown; cursor?: unknown };

/**
 * One step of measuring a folder's size for the import page when the server has no STATUS=SIZE: the messages and bytes of
 * the next window of sequence numbers, newest first (`unsized` of them without a size), the folder's UIDVALIDITY (a change
 * means start again), and where to go on. The page repeats the call with `cursor` until `done`, and
 * adds the steps up. Nothing is stored and the password is not kept. `unavailable` says the server cannot be measured
 * this way; sizes are only a preview, so that never stops an import.
 */
export const POST = withModule("import", async (request, { checkUser }) => {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const denied = await checkUser(auth.user);
	if (denied) return denied;
	let input: ReturnType<typeof parseImapFolderListRequest>;
	let folder: string;
	let cursor: number | null;
	try {
		const resolved = await resolveImportSource(auth.user, await readJsonBody<SizesRequest>(request, 16 * 1024));
		if ("error" in resolved) return resolved.error;
		input = parseImapFolderListRequest(resolved.body);
		if (typeof resolved.body.folder !== "string" || !resolved.body.folder.trim())
			throw new Error("A folder is required");
		folder = resolved.body.folder;
		cursor = parseSizeCursor(resolved.body.cursor);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid IMAP request" }, { status });
	}
	const refused = importServerProblem(env, input);
	if (refused) return NextResponse.json({ error: refused }, { status: 400 });
	try {
		const step = await measureFolderStep(env, input, folder, cursor, undefined, undefined, request.signal);
		if (!step) return NextResponse.json({ unavailable: true }, { headers: { "Cache-Control": "no-store" } });
		return NextResponse.json(
			{
				messages: step.messages,
				bytes: step.bytes,
				unsized: step.unsized,
				uidValidity: step.uidValidity,
				nextCursor: step.nextCursor,
				done: step.nextCursor === null,
				progress: sizeProgress(step.nextCursor, step.exists),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unable to measure the folder" },
			{ status: 502 },
		);
	}
});
