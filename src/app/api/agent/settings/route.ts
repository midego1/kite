import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { AppDatabase } from "@/db";
import { getAutoReadInstallSettings, skipPendingMailboxJobs } from "@/lib/agent/auto-read/install-settings";
import {
	applyMailboxAgentSettingsUpdate,
	autonomyError,
	autoReadInstallFlags,
	configuredModelId,
	describeSettingsError,
	mailboxAgentSettingsUpdateSchema,
	mutedSendersError,
	requiredReviewerAccess,
	unknownModelError,
} from "@/lib/agent/auto-read/settings-utils";
import { CHAT_FIXED_RULES, DRAFT_FIXED_RULES } from "@/lib/agent/fixed-rules-utils";
import { readMailboxAgentSettings, saveMailboxAgentSettings } from "@/lib/agent/auto-read/mailbox-settings";
import { aiWritingMigrationApplied } from "@/lib/agent/ai-writing-migration";

async function listReviewers(db: AppDatabase, mailboxId: string) {
	const reviewers: { id: string; name: string; email: string }[] = [];
	const candidates = await db
		.select({ id: users.id, name: users.name, email: users.email, disabled: users.disabled })
		.from(users)
		.limit(200);
	for (const candidate of candidates)
		if (
			!candidate.disabled &&
			(await getMailboxAccessLevel(db, { id: candidate.id, role: "user" }, mailboxId))?.canSendOnBehalf
		)
			reviewers.push({ id: candidate.id, name: candidate.name, email: candidate.email });
	return reviewers;
}

async function reviewerError(db: AppDatabase, reviewerId: string, mailboxId: string, required: "send" | "read") {
	const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerId)).limit(1);
	const access = reviewer && !reviewer.disabled ? await getMailboxAccessLevel(db, reviewer, mailboxId) : null;
	if (required === "send" && !access?.canSendOnBehalf) return "Reviewer needs mailbox send permission";
	if (required === "read" && !access?.canRead) return "Reviewer needs access to the mailbox";
	return null;
}

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return Response.json({ error: "Mailbox required" }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return Response.json({ error: "Mailbox not found" }, { status: 404 });
	const settings = await readMailboxAgentSettings(db, access);
	const reviewers = access.canManage ? await listReviewers(db, mailboxId) : [];
	const agentProvider = await getAgentProviderPublicConfig(env);
	const provider = agentProvider.configured
		? {
				kind:
					agentProvider.provider === "cloudflare"
						? "Cloudflare Workers AI"
						: agentProvider.preset === "custom"
							? "OpenAI-compatible API"
							: agentProvider.preset,
				model: agentProvider.model,
			}
		: null;
	const models = agentProvider.models;
	return Response.json({
		settings: {
			...settings,
			enabled: true,
			modelId: configuredModelId(settings.modelId, models, models[0] ?? null),
			triageModelId: configuredModelId(settings.triageModelId, models, null),
		},
		models,
		canManage: access.canManage,
		instructionContext: {
			// False until migration 0069 adds the task instruction columns; the fields cannot be saved before.
			ready: await aiWritingMigrationApplied(env),
			// Kite's own rules, shown read-only; served here so the prompt text stays out of the browser bundle.
			fixedRules: { chat: CHAT_FIXED_RULES, draft: DRAFT_FIXED_RULES },
		},
		canConfigureProvider: isPrimaryAdmin(user),
		providerConfigured: agentProvider.configured,
		provider,
		autoReplyEnabled: access.mailbox.autoReplyEnabled,
		reviewers,
		...autoReadInstallFlags(await getAutoReadInstallSettings(env), agentProvider),
	});
}

export async function PUT(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = mailboxAgentSettingsUpdateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: describeSettingsError(parsed.error) }, { status: 400 });
	const unavailable = autonomyError(parsed.data.autonomy);
	if (unavailable) return Response.json({ error: unavailable }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage) return Response.json({ error: "Mailbox not found or permission denied" }, { status: 403 });
	const current = await readMailboxAgentSettings(db, access);
	const mutedError = mutedSendersError(current, parsed.data);
	if (mutedError) return Response.json({ error: mutedError }, { status: 400 });
	const next = applyMailboxAgentSettingsUpdate(current, parsed.data);
	const reviewerId = next.reviewerUserId || access.mailbox.userId;
	const required = requiredReviewerAccess(current, next, access.mailbox.userId);
	const reviewerProblem = required && (await reviewerError(db, reviewerId, access.mailbox.id, required));
	if (reviewerProblem) return Response.json({ error: reviewerProblem }, { status: 400 });
	if (next.autoDraftEnabled && access.mailbox.autoReplyEnabled)
		return Response.json({ error: "Disable the out-of-office auto-reply before enabling AI drafts" }, { status: 400 });
	const { models } = await getAgentProviderPublicConfig(env);
	const modelError = unknownModelError(parsed.data, models);
	if (modelError) return Response.json({ error: modelError }, { status: 400 });
	const values = {
		...next,
		enabled: true,
		modelId: configuredModelId(next.modelId, models, models[0] ?? null),
		triageModelId: configuredModelId(next.triageModelId, models, null),
		reviewerUserId: reviewerId,
		capabilities: JSON.stringify(next.capabilities),
	};
	const { mailboxId } = values;
	if ((await saveMailboxAgentSettings(db, values)) === "migration_pending")
		return Response.json(
			{ error: "Apply the pending database update to save these settings", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	if (!next.autoDraftEnabled) await skipPendingMailboxJobs(env, mailboxId, "draft", "Auto-drafting disabled");
	if (next.autonomy === "off") await skipPendingMailboxJobs(env, mailboxId, "triage", "autonomy_off");
	if (!next.listSummaries) await skipPendingMailboxJobs(env, mailboxId, "line_summary", "list_summaries_off");
	return Response.json({ ok: true });
}
