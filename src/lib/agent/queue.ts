import { processAgentTriageJob } from "./auto-read/process";
import { processLineSummaryJob } from "./summaries/line-job";
import { processAgentDraftJob } from "./jobs/utils";
import { dispatchAgentJob } from "./queue-utils";
import { isStyleBackfillMessage, processStyleBackfill } from "./writing-style";

/**
 * Runs an `agent.draft`, `agent.triage`, `agent.line_summary` or `agent.style_backfill` queue body; false means the body is something
 * else, such as an IMAP import.
 */
export async function processAgentQueueMessage(env: CloudflareEnv, body: unknown): Promise<boolean> {
	if (isStyleBackfillMessage(body)) {
		await processStyleBackfill(env, body);
		return true;
	}
	return dispatchAgentJob(body, {
		draft: (jobId) => processAgentDraftJob(env, jobId),
		triage: (jobId) => processAgentTriageJob(env, jobId),
		line_summary: (jobId) => processLineSummaryJob(env, jobId),
	});
}
