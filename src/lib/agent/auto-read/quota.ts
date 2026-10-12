import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentJobs } from "@/db/schema";
import { allowAgentRequest } from "../rate-limit";
import { utcDayStartSeconds } from "./spend-utils";

/**
 * Whether the mailbox has already completed `limit` triage jobs since 00:00 UTC, by completion
 * time, so jobs created before midnight or recovered from a backlog count on the day they finish.
 * Draft jobs do not count.
 */
export async function triageDailyLimitReached(db: AppDatabase, mailboxId: string, limit: number, now = new Date()) {
	const [usage] = await db
		.select({ count: sql<number>`count(*)` })
		.from(agentJobs)
		.where(
			and(
				eq(agentJobs.mailboxId, mailboxId),
				eq(agentJobs.kind, "triage"),
				eq(agentJobs.status, "completed"),
				gte(agentJobs.completedAt, new Date(utcDayStartSeconds(now) * 1000)),
			),
		);
	return (usage?.count ?? 0) >= limit;
}

/** Takes one token from the per-mailbox automatic reading rate limit; false when it is exhausted. */
export function allowAutoReadRequest(env: CloudflareEnv, mailboxId: string) {
	return allowAgentRequest(env, `auto-read:${mailboxId}`);
}
