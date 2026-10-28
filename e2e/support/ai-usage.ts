import { execFileSync } from "node:child_process";
import { E2E_PERSIST_DIR } from "./constants";

/** One `ai_usage` row as the specs check it: counts and codes, never content. */
export type UsageRow = {
	source: string;
	mailboxId: string | null;
	jobId: string | null;
	reserved: boolean;
	outputTokens: number | null;
	status: string | null;
};

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The `ai_usage` rows of one mailbox or one job, read from the e2e database. Admin → AI usage does not name the
 * mailbox or job of a request in a mailbox the admin cannot open, which every test account's mailbox is.
 */
export function readUsageRows(match: { mailboxId?: string; jobId?: string }): UsageRow[] {
	const where = [
		match.mailboxId ? `mailbox_id = ${quoted(match.mailboxId)}` : null,
		match.jobId ? `job_id = ${quoted(match.jobId)}` : null,
	].filter(Boolean);
	if (!where.length) throw new Error("readUsageRows needs a mailbox or a job");
	const output = execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--local",
			"--persist-to",
			E2E_PERSIST_DIR,
			"--json",
			"--command",
			`SELECT source, mailbox_id AS mailboxId, job_id AS jobId, reserved, output_tokens AS outputTokens, status FROM ai_usage WHERE ${where.join(" AND ")} ORDER BY created_at, id`,
		],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	).toString();
	const [result] = JSON.parse(output) as { results: (Omit<UsageRow, "reserved"> & { reserved: number })[] }[];
	return result.results.map((row) => ({ ...row, reserved: !!row.reserved }));
}
