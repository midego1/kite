import { pauseImportJob } from "@/lib/import/jobs";
import { withModule } from "@/lib/modules/route-guard";
import { importJobMutation } from "../job-mutation";

type Params = { params: Promise<{ id: string }> };

/**
 * Pauses a waiting or running import (spec §4.5). It keeps its saved password and its place, and a batch that is
 * running finishes first; `POST …/resume` continues it.
 */
export const POST = withModule<Params>("import", (request, { params, checkUser }) =>
	importJobMutation(request, params, checkUser, async ({ env, userId, jobId }) =>
		(await pauseImportJob(env, userId, jobId))
			? Response.json({ ok: true })
			: Response.json({ error: "Import job not found or not running" }, { status: 404 }),
	),
);
