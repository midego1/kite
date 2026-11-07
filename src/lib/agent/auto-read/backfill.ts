import { and, asc, eq, gt, gte, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings, mailboxes, messageAttachments, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getEnv } from "@/lib/cloudflare";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import type { HostBackfillMessage, HostBackfillPage, HostBackfillQuery } from "@/lib/modules/host-types";
import { isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue, ModuleId } from "@/lib/modules/module-types";
import { aiOffMailboxIds } from "../mailbox-ai";
import { getAutoReadInstallSettings } from "./install-settings";
import { stepSwitchOn, triageStepsFor } from "./module-steps-utils";
import { isPaused } from "./schedule-utils";
import { resolveMailboxAgentSettings } from "./settings-utils";
import type { MailboxAgentSettingsState } from "./settings-types";
import { buildStepInput } from "./step-input-utils";
import { loadTriageContext } from "./triage-context";

/**
 * Backfill for module triage steps (spec money-watch §25.5): the inbound mail a step would have read had it been on,
 * for a module to work through in its own background job. The same rules as a triage job decide which mailboxes count:
 * the viewer is the reviewer, automatic reading is on and not paused, AI is not off, the install's assistant and
 * automatic reading are on, the module is on for the viewer and the step's own switch is on for the mailbox. Spam,
 * trash, drafts, sent mail, templates and Screener-held mail are never listed.
 */

const TRIAGE_STEPS = triageStepsFor(MODULE_CAPABILITIES);
/** Inbound mail a reader has kept: the Inbox and folders (`received`) and the archive. */
const BACKFILL_STATUSES = ["received", "archived"];
const MAX_PAGE = 500;

type Viewer = NonNullable<CapabilityCallContext["viewer"]>;

type Eligible = { mailboxId: string; settings: MailboxAgentSettingsState; ownerUserId: string };

function stepFor(moduleId: ModuleId, capability: string) {
	return TRIAGE_STEPS.find((step) => step.moduleId === moduleId && step.capability === capability) ?? null;
}

/** The mailboxes whose mail the viewer's step may read in the background, with their resolved settings. */
async function eligibleMailboxes(
	env: CloudflareEnv,
	viewer: Viewer,
	moduleId: ModuleId,
	capability: string,
): Promise<Eligible[]> {
	const step = stepFor(moduleId, capability);
	if (!step || !(await isModuleEnabled(viewer, moduleId))) return [];
	const install = await getAutoReadInstallSettings(env);
	if (!install.agentEnabled || !install.autoReadEnabled) return [];
	const db = getDb(env);
	const rows = await db
		.select({ settings: mailboxAgentSettings, mailbox: mailboxes })
		.from(mailboxAgentSettings)
		.innerJoin(mailboxes, eq(mailboxes.id, mailboxAgentSettings.mailboxId))
		// Narrowed in code below: an unset reviewer means the mailbox's owner.
		.where(or(eq(mailboxAgentSettings.reviewerUserId, viewer.userId), eq(mailboxes.userId, viewer.userId)));
	const candidates = rows
		.map(({ settings, mailbox }) => ({
			mailboxId: mailbox.id,
			ownerUserId: mailbox.userId,
			settings: resolveMailboxAgentSettings(settings, {
				mailboxId: mailbox.id,
				ownerUserId: mailbox.userId,
				mailboxType: mailbox.type,
			}),
		}))
		.filter(
			(entry) =>
				(entry.settings.reviewerUserId || entry.ownerUserId) === viewer.userId &&
				entry.settings.autonomy !== "off" &&
				!isPaused(entry.settings.pausedUntil) &&
				stepSwitchOn(step, entry.settings.capabilities),
		);
	if (candidates.length === 0) return [];
	const off = await aiOffMailboxIds(
		db,
		candidates.map((entry) => entry.mailboxId),
	);
	const [reviewer] = await db.select().from(users).where(eq(users.id, viewer.userId)).limit(1);
	if (!reviewer || reviewer.disabled) return [];
	const eligible: Eligible[] = [];
	for (const entry of candidates) {
		if (off.has(entry.mailboxId)) continue;
		if ((await getMailboxAccessLevel(db, reviewer, entry.mailboxId))?.canRead) eligible.push(entry);
	}
	return eligible;
}

async function attachmentsOf(env: CloudflareEnv, ids: string[]) {
	if (ids.length === 0) return new Map<string, HostBackfillMessage["attachments"]>();
	const rows = await getDb(env)
		.select({
			messageId: messageAttachments.messageId,
			id: messageAttachments.id,
			contentType: messageAttachments.contentType,
			filename: messageAttachments.filename,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(inJsonArray(messageAttachments.messageId, ids));
	const byMessage = new Map<string, HostBackfillMessage["attachments"]>();
	for (const { messageId, ...attachment } of rows)
		byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), attachment]);
	return byMessage;
}

/**
 * One page of the inbound mail the viewer's step may read, oldest first from `since`, after the `after` cursor. Only
 * light columns are read (no body, no raw message), so a module can pick the few worth a full step input.
 */
export async function backfillMessages(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	query: HostBackfillQuery,
): Promise<HostBackfillPage> {
	if (!ctx.viewer) return { messages: [], next: null };
	const env = getEnv();
	const eligible = await eligibleMailboxes(env, ctx.viewer, moduleId, query.capability);
	if (eligible.length === 0) return { messages: [], next: null };
	const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(query.limit)));
	const since = new Date(query.since);
	const after = query.after ? { at: new Date(query.after.receivedAt), id: query.after.id } : null;
	const rows = await getDb(env)
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			from: messages.fromAddr,
			subject: messages.subject,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(
			and(
				inJsonArray(
					messages.mailboxId,
					eligible.map((entry) => entry.mailboxId),
				),
				eq(messages.direction, "inbound"),
				inArray(messages.status, BACKFILL_STATUSES),
				gte(messages.createdAt, since),
				after
					? or(gt(messages.createdAt, after.at), and(eq(messages.createdAt, after.at), gt(messages.id, after.id)))
					: undefined,
			),
		)
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(limit);
	const attachments = await attachmentsOf(
		env,
		rows.map((row) => row.id),
	);
	const page = rows.map((row) => ({
		id: row.id,
		mailboxId: row.mailboxId ?? "",
		from: row.from,
		subject: row.subject,
		receivedAt: row.createdAt.toISOString(),
		attachments: attachments.get(row.id) ?? [],
	}));
	const last = page[page.length - 1];
	return { messages: page, next: rows.length === limit && last ? { receivedAt: last.receivedAt, id: last.id } : null };
}

/**
 * The triage step input (with `model: null`) for one inbound message a backfill listed, after checking every rule of
 * `backfillMessages` again; null when the message is no longer one the step may read.
 */
export async function backfillStepInput(
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	request: { messageId: string; capability: string },
): Promise<JsonValue | null> {
	if (!ctx.viewer || typeof request.messageId !== "string") return null;
	const env = getEnv();
	const db = getDb(env);
	const [source] = await db.select().from(messages).where(eq(messages.id, request.messageId)).limit(1);
	if (!source?.mailboxId || source.direction !== "inbound" || !BACKFILL_STATUSES.includes(source.status)) return null;
	const eligible = (await eligibleMailboxes(env, ctx.viewer, moduleId, request.capability)).find(
		(entry) => entry.mailboxId === source.mailboxId,
	);
	if (!eligible) return null;
	const context = await loadTriageContext(env, source, eligible.ownerUserId);
	const attachments = await db
		.select({
			id: messageAttachments.id,
			contentType: messageAttachments.contentType,
			filename: messageAttachments.filename,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, source.id));
	const input = buildStepInput({
		source: context.source,
		mailboxId: source.mailboxId,
		facts: context.facts,
		headers: context.headers,
		bodyText: context.bodyText,
		attachments,
		model: null,
		muted: (eligible.settings.capabilities.mutedSenders ?? []).includes(context.facts.senderAddress),
	});
	return JSON.parse(JSON.stringify(input)) as JsonValue;
}
