import { and, asc, eq, gt, gte, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings, mailboxes, messageAttachments, messages, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { screenerPendingRows } from "@/lib/screener/views";
import { getEnv } from "@/lib/cloudflare";
import { MODULE_CAPABILITIES } from "@/lib/modules/capability-registry";
import type { HostBackfillMessage, HostBackfillPage, HostBackfillQuery } from "@/lib/modules/host-types";
import { isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue, ModuleId } from "@/lib/modules/module-types";
import { aiOffMailboxIds } from "../mailbox-ai";
import { getAutoReadInstallSettings } from "./install-settings";
import { stepSwitchOn, triageStepsFor } from "./module-steps-utils";
import { isPaused, triageMessageGate } from "./schedule-utils";
import { resolveMailboxAgentSettings } from "./settings-utils";
import type { MailboxAgentSettingsState } from "./settings-types";
import { buildStepInput } from "./step-input-utils";
import { loadTriageContext } from "./triage-context";
import { databaseKey } from "@/lib/d1-session-utils";

/**
 * Backfill for module triage steps (spec money-watch §25.5): the inbound mail a step would have read had it been on,
 * for a module to work through in its own background job. The same rules as a triage job decide which mailboxes count:
 * the viewer is the reviewer, automatic reading is on and not paused, AI is not off, the install's assistant and
 * automatic reading are on, the module is on for the viewer and the step's own switch is on for the mailbox. Each
 * message then passes the live triage gate (`triageMessageGate`: not from the mailbox's own addresses or a bounce
 * sender) and is not waiting for a Screener decision (held, or an undecided sender in an Inbox-mode mailbox). Spam,
 * trash, drafts, sent mail and templates are never listed.
 */

const TRIAGE_STEPS = triageStepsFor(MODULE_CAPABILITIES);
/** Inbound mail a reader has kept: the Inbox and folders (`received`) and the archive. */
const BACKFILL_STATUSES = ["received", "archived"];
const MAX_PAGE = 500;
/** How long one viewer's eligible mailboxes are reused, so a scan run does not resolve them for every message. */
const ELIGIBLE_TTL_MS = 15_000;

type Viewer = NonNullable<CapabilityCallContext["viewer"]>;

type Eligible = {
	mailboxId: string;
	settings: MailboxAgentSettingsState;
	ownerUserId: string;
	/** The mailbox's own addresses, which the live gate refuses as senders. */
	ownAddresses: string[];
};

/** Per database binding, so a cached answer never crosses databases. */
const eligibleCaches = new WeakMap<object, Map<string, { at: number; value: Promise<Eligible[]> }>>();

/** The module's triage step whose per-mailbox switch is `switchKey`. */
function stepFor(moduleId: ModuleId, switchKey: string) {
	return TRIAGE_STEPS.find((step) => step.moduleId === moduleId && step.switchKey === switchKey) ?? null;
}

/** The eligible mailboxes, reused for a few seconds per viewer, module and switch. */
function eligibleMailboxes(env: CloudflareEnv, viewer: Viewer, moduleId: ModuleId, capability: string) {
	const key = `${viewer.userId}\n${moduleId}\n${capability}`;
	const now = Date.now();
	let eligibleCache = eligibleCaches.get(databaseKey(env.DB));
	if (!eligibleCache) eligibleCaches.set(databaseKey(env.DB), (eligibleCache = new Map()));
	const cached = eligibleCache.get(key);
	if (cached && now - cached.at < ELIGIBLE_TTL_MS) return cached.value;
	const value = resolveEligible(env, viewer, moduleId, capability);
	eligibleCache.set(key, { at: now, value });
	value.catch(() => eligibleCache.delete(key));
	return value;
}

/** The mailboxes whose mail the viewer's step may read in the background, with their resolved settings. */
async function resolveEligible(
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
			mailbox,
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
	for (const { mailbox, ...entry } of candidates) {
		if (off.has(entry.mailboxId)) continue;
		if (!(await getMailboxAccessLevel(db, reviewer, entry.mailboxId))?.canRead) continue;
		eligible.push({ ...entry, ownAddresses: await getMailboxDomainAddresses(db, mailbox) });
	}
	return eligible;
}

type GateRow = { id: string; mailboxId: string | null; status: string; direction: string; fromAddr: string };

/**
 * The rows live triage would also read: the gate's sender rules (archived mail counts as kept, and `Auto-Submitted`
 * mail passes because the step opted in to it) and no pending Screener decision.
 */
async function passingGate(
	env: CloudflareEnv,
	eligible: readonly Eligible[],
	rows: readonly GateRow[],
	headers?: Record<string, string>,
): Promise<Set<string>> {
	const byMailbox = new Map(eligible.map((entry) => [entry.mailboxId, entry]));
	const gated = rows.filter((row) => {
		const entry = row.mailboxId ? byMailbox.get(row.mailboxId) : undefined;
		if (!entry) return false;
		const gate = triageMessageGate({
			status: "received",
			sender: row.fromAddr,
			headers,
			ownAddresses: entry.ownAddresses,
		});
		return gate === null || gate === "auto_submitted";
	});
	// Archived mail from an undecided sender was never read by live triage either, so it counts as received here.
	const pending = await screenerPendingRows(
		getDb(env),
		gated.map((row) => (row.status === "archived" ? { ...row, status: "received" } : row)),
	);
	return new Set(gated.filter((row) => !pending.has(row.id)).map((row) => row.id));
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
	if (!ctx.viewer) return { messages: [], read: 0, next: null };
	const env = getEnv();
	const eligible = await eligibleMailboxes(env, ctx.viewer, moduleId, query.capability);
	if (eligible.length === 0) return { messages: [], read: 0, next: null };
	const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(query.limit)));
	const since = new Date(query.since);
	const after = query.after ? { at: new Date(query.after.receivedAt), id: query.after.id } : null;
	const rows = await getDb(env)
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			fromAddr: messages.fromAddr,
			status: messages.status,
			direction: messages.direction,
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
	const passing = await passingGate(env, eligible, rows);
	const kept = rows.filter((row) => passing.has(row.id));
	const attachments = await attachmentsOf(
		env,
		kept.map((row) => row.id),
	);
	const page = kept.map((row) => ({
		id: row.id,
		mailboxId: row.mailboxId ?? "",
		from: row.fromAddr,
		subject: row.subject,
		receivedAt: row.createdAt.toISOString(),
		attachments: attachments.get(row.id) ?? [],
	}));
	// The cursor follows the last row read, also when the gate left it out.
	const last = rows[rows.length - 1];
	return {
		messages: page,
		read: rows.length,
		next: rows.length === limit && last ? { receivedAt: last.createdAt.toISOString(), id: last.id } : null,
	};
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
	if (!(await passingGate(env, [eligible], [source], context.headers)).has(source.id)) return null;
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
