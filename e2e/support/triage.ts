import { expect, type APIRequestContext } from "@playwright/test";
import { okJson } from "./auto-read";

export type AgentJobRow = {
	id: string;
	kind: "draft" | "triage";
	status: string;
	reason: string | null;
	draftId: string | null;
	sourceMessageId: string;
};

export async function readJobs(api: APIRequestContext, mailboxId: string): Promise<AgentJobRow[]> {
	const { jobs } = await okJson<{ jobs: AgentJobRow[] }>(
		await api.get(`/api/agent/jobs?mailboxId=${encodeURIComponent(mailboxId)}`),
	);
	return jobs;
}

async function jobsForMessage(api: APIRequestContext, mailboxId: string, messageId: string) {
	return (await readJobs(api, mailboxId)).filter((job) => job.sourceMessageId === messageId);
}

/** Polls until the message has a job of this kind in a finished state, and returns it. */
export async function waitForFinishedJob(
	api: APIRequestContext,
	mailboxId: string,
	messageId: string,
	kind: AgentJobRow["kind"],
): Promise<AgentJobRow> {
	let found: AgentJobRow | undefined;
	await expect
		.poll(
			async () => {
				found = (await jobsForMessage(api, mailboxId, messageId)).find((job) => job.kind === kind);
				return found?.status ?? "none";
			},
			{ timeout: 30_000, intervals: [250, 500, 1000] },
		)
		.toMatch(/^(completed|skipped|failed)$/);
	return found!;
}
