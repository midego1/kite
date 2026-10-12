import { and, count, eq, gte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { outboundJobs } from "@/db/schema";
import { describeSendLimitBreach, resolveSendLimits } from "./send-limits-utils";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function countSince(env: CloudflareEnv, userId: string, since: Date): Promise<number> {
	const [row] = await getDb(env)
		.select({ total: count() })
		.from(outboundJobs)
		.where(
			and(
				eq(outboundJobs.userId, userId),
				gte(outboundJobs.createdAt, since),
				// An undone send never left, so it does not use up the allowance.
				ne(outboundJobs.status, "cancelled"),
			),
		);
	return row?.total ?? 0;
}

/**
 * Refuses a send once the user has queued or sent too many messages in the last hour or day.
 * Every outbound path (the composer, the API, JMAP, MCP approvals, calendar invitations and
 * automatic replies) goes through `sendEmail`, so one check covers a stolen session or API key.
 * The count is not atomic: parallel requests can overshoot by a few messages.
 */
export async function assertWithinSendLimits(env: CloudflareEnv, userId: string): Promise<void> {
	const limits = resolveSendLimits(env);
	if (limits.perHour === 0 && limits.perDay === 0) return;
	const now = Date.now();
	const lastDay = limits.perDay > 0 ? await countSince(env, userId, new Date(now - DAY_MS)) : 0;
	const lastHour = limits.perHour > 0 ? await countSince(env, userId, new Date(now - HOUR_MS)) : 0;
	const breach = describeSendLimitBreach({ lastHour, lastDay }, limits);
	if (breach) throw new Error(breach);
}
