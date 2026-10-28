import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { createImportJob, listImportJobs, serializeImportJob } from "@/lib/import/jobs";
import { checkImportStart } from "@/lib/import/size-guard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { parseImapImportRequest } from "../imap/utils";
import type { ImapImportJobRequest } from "./types";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("import", async (request, { checkUser }) => {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	const jobs = await listImportJobs(env, user.id);
	return Response.json({ jobs: jobs.map(serializeImportJob), queue: !!env.AGENT_QUEUE });
});

export const POST = withModule("import", async (request, { checkUser }) => {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });

	let body: ImapImportJobRequest;
	let input: ReturnType<typeof parseImapImportRequest>;
	try {
		body = await readJsonBody<ImapImportJobRequest>(request, 16 * 1024);
		input = parseImapImportRequest(body);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return Response.json({ error: error instanceof Error ? error.message : "Invalid IMAP import request" }, { status });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found" }, { status: 404 });
	if (input.destination.type === "folder") {
		const [folder] = await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.id, input.destination.folderId), eq(folders.mailboxId, access.mailbox.id)))
			.limit(1);
		if (!folder) return Response.json({ error: "Folder not found" }, { status: 404 });
	}

	const maxMessages = body.importAll === false ? Math.min(Math.max(Number(body.limit) || 100, 1), 10_000) : null;
	// Above 90% of the database limit (now, or once `maxMessages` more are added) the user has to say "Import anyway".
	const sizeCheck = await checkImportStart(env, request, {
		messages: maxMessages,
		confirmed: body.confirmDatabaseFull === true,
	});
	if (sizeCheck.refusal) return sizeCheck.refusal;
	const job = await createImportJob(env, {
		userId: user.id,
		mailboxId: access.mailbox.id,
		label: (body.label?.trim() || input.folder).slice(0, 200),
		destination: body.destination?.trim() || "system:inbox",
		host: input.host,
		port: input.port,
		secure: input.secure,
		username: input.username,
		password: input.password,
		folder: input.folder,
		maxMessages,
		confirmedDatabaseFull: sizeCheck.confirmed,
	});
	return Response.json({ job: serializeImportJob(job) }, { status: 201 });
});
