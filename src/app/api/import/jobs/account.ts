import { getDb } from "@/db";
import { ImportMigrationPendingError } from "@/lib/import/account-jobs";
import { GMAIL_LABELS_DESTINATION, parseAccountFolderRequest } from "@/lib/import/folder-mapping-utils";
import { resolveImportDestination } from "@/lib/import/folders";
import { importServerProblem } from "@/lib/import/imap";
import { createAccountImportJob, serializeImportJob } from "@/lib/import/jobs";
import { checkImportStart } from "@/lib/import/size-guard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { parseImapFolderListRequest } from "../imap/folders/utils";
import type { AccountImportJobRequest } from "./types";

type SessionUser = Parameters<typeof getMailboxAccessLevel>[1];

/**
 * `POST /api/import/jobs` with `scope: "account"`: one job over the folders the user kept in the mapping table.
 * New Kite folders are created only once the request has passed every check.
 */
export async function createAccountJobResponse(
	env: CloudflareEnv,
	request: Request,
	user: SessionUser & { id: string },
	body: AccountImportJobRequest,
): Promise<Response> {
	let account: ReturnType<typeof parseImapFolderListRequest>;
	let folders: ReturnType<typeof parseAccountFolderRequest>;
	try {
		if (!body.mailboxId) throw new Error("Mailbox is required");
		account = parseImapFolderListRequest(body);
		folders = parseAccountFolderRequest(body.folders);
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Invalid import request" }, { status: 400 });
	}
	const refused = importServerProblem(env, account);
	if (refused) return Response.json({ error: refused }, { status: 400 });
	const access = await getMailboxAccessLevel(getDb(env), user, body.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found" }, { status: 404 });

	const counts = (Array.isArray(body.folders) ? body.folders : [])
		.filter((folder) => folder?.include !== false)
		.map((folder) => Number(folder?.messages));
	const messages = counts.every((count) => Number.isFinite(count) && count >= 0)
		? counts.reduce((sum, count) => sum + count, 0)
		: null;
	const sizeCheck = await checkImportStart(env, request, { messages, confirmed: body.confirmDatabaseFull === true });
	if (sizeCheck.refusal) return sizeCheck.refusal;

	const mailbox = { id: access.mailbox.id, userId: access.mailbox.userId };
	try {
		const resolved = [];
		for (const folder of folders) {
			const destination = await resolveImportDestination(env, mailbox, folder.destination);
			if (!destination) return Response.json({ error: "Folder not found" }, { status: 404 });
			resolved.push({ ...folder, destination });
		}
		const job = await createAccountImportJob(env, {
			userId: user.id,
			mailboxId: mailbox.id,
			label: (body.label?.trim() || `Whole account: ${account.username}`).slice(0, 200),
			host: account.host,
			port: account.port,
			secure: account.secure,
			username: account.username,
			password: account.password,
			folders: resolved,
			gmail: resolved.some((folder) => folder.destination === GMAIL_LABELS_DESTINATION),
			confirmedDatabaseFull: sizeCheck.confirmed,
		});
		return Response.json({ job: serializeImportJob(job) }, { status: 201 });
	} catch (error) {
		if (error instanceof ImportMigrationPendingError)
			return Response.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
		throw error;
	}
}
