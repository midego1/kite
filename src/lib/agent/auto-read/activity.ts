import { and, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { agentJobs, messages, users } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { neutralRefLabel, refTarget } from "@/lib/modules/record-ref-utils";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import { toActivityAction } from "./actions-utils";
import { calendarActionRef, isCalendarAction } from "./activity-ref-utils";

const ACTION_LIMIT = 100;
const SKIPPED_JOB_LIMIT = 20;
const SKIPPED_JOB_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const drafts = alias(messages, "draft");

export type ActivityViewer = { userId: string; role: string; isPrimaryAdmin: boolean; timeZone?: string | null };

async function toViewer(db: ReturnType<typeof getDb>, viewer: string | ActivityViewer): Promise<ActivityViewer> {
	if (typeof viewer !== "string") return viewer;
	const [row] = await db
		.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin, timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, viewer))
		.limit(1);
	return {
		userId: viewer,
		role: row?.role ?? "user",
		isPrimaryAdmin: row?.isPrimaryAdmin ?? false,
		timeZone: row?.timeZone,
	};
}

type ActivityRow = ReturnType<typeof toActivityAction>;
type ActivityTargetOverride = { target?: { href: string | null; label: string }; hideSubject: boolean };

/**
 * Calendar actions show their calendar event through a record ref, so a viewer who has Calendar off, no
 * access to the event, or an event that is gone sees the neutral label as plain text. A calendar action
 * with no recorded event (an RSVP) keeps the invitation mail as its target while Calendar is on.
 */
async function calendarTargets(
	env: CloudflareEnv,
	viewer: CapabilityCallContext["viewer"] & object,
	timeZone: string,
	actions: ActivityRow[],
): Promise<Map<string, ActivityTargetOverride>> {
	const calendar = actions.filter((row) => isCalendarAction(row.action));
	const overrides = new Map<string, ActivityTargetOverride>();
	if (calendar.length === 0) return overrides;
	const refs = calendar.map((row) => ({ row, ref: calendarActionRef(row) }));
	const asked = refs.flatMap((entry) => (entry.ref ? [entry.ref] : []));
	const resolved = asked.length > 0 ? await resolveRecordRefs(env, viewer, asked, { timeZone }) : [];
	const calendarOn = refs.some((entry) => !entry.ref) ? await isModuleEnabled(viewer, "calendar") : true;
	for (const { row, ref } of refs) {
		const answer = ref ? resolved.find((item) => item.kind === ref.kind && item.id === ref.id) : undefined;
		if (answer) overrides.set(row.id, { target: refTarget(answer), hideSubject: !!answer.unavailable });
		else if (!calendarOn)
			overrides.set(row.id, { target: { href: null, label: neutralRefLabel("calendar:event") }, hideSubject: true });
	}
	return overrides;
}

/**
 * The mailbox's audit log, newest first, plus recently skipped triage jobs and their reasons.
 * `draftAvailable` tells whether the viewer can open the row's draft: agent drafts are private to the
 * reviewer, and a discarded draft is gone.
 */
export async function listAgentActivity(
	env: CloudflareEnv,
	mailboxId: string,
	viewerOrId: string | ActivityViewer,
	now = new Date(),
) {
	const db = getDb(env);
	const viewer = await toViewer(db, viewerOrId);
	const rows = await db
		.select({
			action: agentActions,
			subject: messages.subject,
			draftUserId: drafts.userId,
			draftStatus: drafts.status,
		})
		.from(agentActions)
		.leftJoin(messages, eq(messages.id, agentActions.messageId))
		.leftJoin(drafts, eq(drafts.id, sql`json_extract(${agentActions.after}, '$.draftId')`))
		.where(eq(agentActions.mailboxId, mailboxId))
		// Timestamps are whole seconds, so insertion order breaks ties (an undo and its inverse row share a second).
		.orderBy(desc(agentActions.createdAt), desc(sql`agent_actions.rowid`))
		.limit(ACTION_LIMIT);
	const skippedJobs = await db
		.select({
			id: agentJobs.id,
			reason: agentJobs.reason,
			sourceMessageId: agentJobs.sourceMessageId,
			subject: messages.subject,
			createdAt: agentJobs.createdAt,
		})
		.from(agentJobs)
		.leftJoin(messages, eq(messages.id, agentJobs.sourceMessageId))
		.where(
			and(
				eq(agentJobs.mailboxId, mailboxId),
				eq(agentJobs.kind, "triage"),
				eq(agentJobs.status, "skipped"),
				gte(agentJobs.createdAt, new Date(now.getTime() - SKIPPED_JOB_WINDOW_MS)),
			),
		)
		.orderBy(desc(agentJobs.createdAt))
		.limit(SKIPPED_JOB_LIMIT);
	const activity = rows.map((row) => toActivityAction(row.action, now));
	const targets = await calendarTargets(env, viewer, viewer.timeZone || "UTC", activity);
	return {
		actions: activity.map((action, index) => {
			const row = rows[index];
			const override = targets.get(action.id);
			return {
				...action,
				subject: override?.hideSubject ? null : row.subject,
				draftAvailable: row.draftStatus === "draft" && row.draftUserId === viewer.userId,
				...(override?.target ? { target: override.target } : {}),
			};
		}),
		skippedJobs: skippedJobs.map((job) => ({ ...job, createdAt: job.createdAt.toISOString() })),
	};
}
