import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { importServerProblem, planAccountImport } from "@/lib/import/imap";
import { withModule } from "@/lib/modules/route-guard";
import { resolveImportSource } from "../../connected-account";
import type { ImapFolderListRequest } from "../../imap/folders/types";
import { parseImapFolderListRequest } from "../../imap/folders/utils";

/**
 * The mapping table of a whole-account import (spec §4.1): every folder of the source with its proposed role and
 * destination, message count and, where the server says, size. Nothing is stored and the password is not kept; with
 * `accountId` the login of that connected account is used instead of a typed one.
 */
export const POST = withModule("import", async (request, { checkUser }) => {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const denied = await checkUser(auth.user);
	if (denied) return denied;
	let input: ReturnType<typeof parseImapFolderListRequest>;
	try {
		const resolved = await resolveImportSource(
			auth.user,
			await readJsonBody<ImapFolderListRequest & { accountId?: unknown }>(request, 16 * 1024),
		);
		if ("error" in resolved) return resolved.error;
		input = parseImapFolderListRequest(resolved.body);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid IMAP request" }, { status });
	}
	const refused = importServerProblem(env, input);
	if (refused) return NextResponse.json({ error: refused }, { status: 400 });
	try {
		return NextResponse.json(await planAccountImport(env, input));
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unable to read the account's folders" },
			{ status: 502 },
		);
	}
});
