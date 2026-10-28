import { getDb } from "@/db";
import { ImportJobSaveError, ImportMigrationPendingError, assertAccountImportsReady } from "@/lib/import/account-jobs";
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
 * New Kite folders are created only once the request has passed every check, the folder destinations included.
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

	// The plan's counts come back from the client, so they are advisory: one unknown count makes the total unknown
	// (the estimate then looks at the database as it is), and the run's size guard pauses the job at the stop point
	// whatever the client claimed.
	const counts = folders.map((folder) => folder.messages);
	const messages = counts.every((count) => count !== null)
		? counts.reduce<number>((sum, count) => sum + count!, 0)
		: null;
	const sizeCheck = await checkImportStart(env, request, { messages, confirmed: body.confirmDatabaseFull === true });
	if (sizeCheck.refusal) return sizeCheck.refusal;

	const mailbox = { id: access.mailbox.id, userId: access.mailbox.userId };
	try {
		await assertAccountImportsReady(env);
		// Every existing destination is checked before any new folder is created, so a refused request leaves none.
		for (const folder of folders)
			if (
				folder.destination.startsWith("folder:") &&
				!(await resolveImportDestination(env, mailbox, folder.destination))
			)
				return Response.json({ error: "Folder not found" }, { status: 404 });
		const resolved = [];
		for (const folder of folders) {
			const isNew = folder.destination.startsWith("new:");
			const destination = isNew ? await resolveImportDestination(env, mailbox, folder.destination) : folder.destination;
			resolved.push({ ...folder, destination: destination! });
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
		if (error instanceof ImportJobSaveError) return Response.json({ error: error.message }, { status: 500 });
		// A database error's message carries the SQL; only its name is logged and the user gets a plain answer.
		console.error("import.account_job_failed", error instanceof Error ? error.name : "unknown");
		return Response.json({ error: "The import could not be started. Try again." }, { status: 500 });
	}
}
