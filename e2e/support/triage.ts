import { expect, type APIRequestContext } from "@playwright/test";
import { okJson } from "./auto-read";

export type AgentJobRow = {
	id: string;
	kind: "draft" | "triage" | "line_summary";
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
	timeout = 30_000,
): Promise<AgentJobRow> {
	let found: AgentJobRow | undefined;
	await expect
		.poll(
			async () => {
				found = (await jobsForMessage(api, mailboxId, messageId)).find((job) => job.kind === kind);
				return found?.status ?? "none";
			},
			{ timeout, intervals: [250, 500, 1000] },
		)
		.toMatch(/^(completed|skipped|failed)$/);
	return found!;
}

export type AgentActionRow = {
	id: string;
	initiator: "agent" | "user";
	action: string;
	variant: string;
	undoOf: string | null;
	status: string;
	reason: string | null;
	suggestionId: string | null;
	messageId: string | null;
	after: Record<string, unknown> | null;
	draftAvailable: boolean;
};

/** The mailbox's audit log as a full-access user sees it in Activity. */
export async function readActions(api: APIRequestContext, mailboxId: string): Promise<AgentActionRow[]> {
	const { actions } = await okJson<{ actions: AgentActionRow[] }>(
		await api.get(`/api/agent/actions?mailboxId=${encodeURIComponent(mailboxId)}`),
	);
	return actions;
}

type SuggestionRow = {
	id: string;
	mailboxId: string;
	messageId: string;
	kind: string;
	status: string;
	draftId: string | null;
	canReviewDraft: boolean;
	payload: Record<string, unknown>;
};

export type SuggestionList = {
	suggestions: SuggestionRow[];
	total: number;
	mailboxes: { id: string; address: string; autonomy: string }[];
};

/** `GET /api/agent/suggestions`; without a mailbox it lists open suggestions across full-access mailboxes. */
export async function readSuggestions(
	api: APIRequestContext,
	query: { mailboxId?: string; status?: string; messageId?: string } = {},
): Promise<SuggestionList> {
	const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => !!entry[1]));
	return okJson<SuggestionList>(await api.get(`/api/agent/suggestions?${params}`));
}
