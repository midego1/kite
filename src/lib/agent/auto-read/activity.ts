import { and, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { agentJobs, messages, users } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, ModuleId } from "@/lib/modules/module-types";
import { neutralRefLabel, refTarget } from "@/lib/modules/record-ref-utils";
import { resolveRecordRefs } from "@/lib/modules/record-refs";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { toActivityAction } from "./actions-utils";
import { moduleActionRef } from "./activity-ref-utils";
import { moduleActionOwner } from "./module-actions-utils";
import { MODULE_SKIP_PREFIX } from "./module-steps-utils";

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

/** The neutral label of a module's first record kind, shown for its actions while the module is off. */
function moduleOffLabel(moduleId: ModuleId): string {
	const kind = MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)?.recordKinds[0]?.kind;
	return neutralRefLabel(kind ?? "");
}

/**
 * Module actions show the record they touched through a record ref, so a viewer who has the module off,
 * no access to the record, or a record that is gone sees the neutral label as plain text. A module
 * action with no recorded ref (an RSVP) keeps the message as its target while the module is on.
 */
async function moduleTargets(
	env: CloudflareEnv,
	viewer: CapabilityCallContext["viewer"] & object,
	timeZone: string,
	actions: ActivityRow[],
): Promise<Map<string, ActivityTargetOverride>> {
	const overrides = new Map<string, ActivityTargetOverride>();
	const owned = actions.flatMap((row) => {
		const owner = moduleActionOwner(row.action);
		return owner ? [{ row, moduleId: owner.moduleId, ref: moduleActionRef(row, owner.moduleId) }] : [];
	});
	if (owned.length === 0) return overrides;
	const asked = owned.flatMap((entry) => (entry.ref ? [entry.ref] : []));
	const resolved = asked.length > 0 ? await resolveRecordRefs(env, viewer, asked, { timeZone }) : [];
	const unreferenced = new Set(owned.filter((entry) => !entry.ref).map((entry) => entry.moduleId));
	const off = new Set<ModuleId>();
	for (const moduleId of unreferenced) if (!(await isModuleEnabled(viewer, moduleId))) off.add(moduleId);
	for (const { row, moduleId, ref } of owned) {
		const answer = ref ? resolved.find((item) => item.kind === ref.kind && item.id === ref.id) : undefined;
		if (answer) overrides.set(row.id, { target: refTarget(answer), hideSubject: !!answer.unavailable });
		else if (!ref && off.has(moduleId))
			overrides.set(row.id, { target: { href: null, label: moduleOffLabel(moduleId) }, hideSubject: true });
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
				// A finished job that skipped a module's step is listed too: its other suggestions were made.
				or(
					eq(agentJobs.status, "skipped"),
					and(eq(agentJobs.status, "completed"), like(agentJobs.reason, `${MODULE_SKIP_PREFIX}%`)),
				),
				gte(agentJobs.createdAt, new Date(now.getTime() - SKIPPED_JOB_WINDOW_MS)),
			),
		)
		.orderBy(desc(agentJobs.createdAt))
		.limit(SKIPPED_JOB_LIMIT);
	const activity = rows.map((row) => toActivityAction(row.action, now));
	const targets = await moduleTargets(env, viewer, viewer.timeZone || "UTC", activity);
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
