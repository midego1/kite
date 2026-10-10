import { processAgentTriageJob } from "./auto-read/process";
import { processAgentDraftJob } from "./jobs/utils";
import { dispatchAgentJob } from "./queue-utils";

/** Runs an `agent.draft` or `agent.triage` queue body; false means the body is something else, such as an IMAP import. */
export function processAgentQueueMessage(env: CloudflareEnv, body: unknown): Promise<boolean> {
	return dispatchAgentJob(body, {
		draft: (jobId) => processAgentDraftJob(env, jobId),
		triage: (jobId) => processAgentTriageJob(env, jobId),
	});
}
