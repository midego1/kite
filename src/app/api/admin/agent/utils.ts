import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentJobs, agentSendApprovals, appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getAgentEnabled, getAgentProviderPublicConfig } from "@/lib/agent/provider";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { prepareAgentProviderValues, providerSchema } from "@/lib/agent/provider-admin";
import {
	activeAgentProviderId,
	createAgentProvider,
	listAgentProviders,
	saveLegacyAgentProvider,
	updateAgentProvider,
} from "@/lib/agent/provider-connections";
import { autoReadAdminSchema, isAutoReadAdminBody } from "@/lib/agent/auto-read/settings-utils";
import {
	getAutoReadAdminSettings,
	saveAutoReadAdminSettings,
	TokenCapsPendingError,
} from "@/lib/agent/auto-read/install-settings";

const enabledSchema = z.object({ enabled: z.boolean() });

/** The primary admin only; a write also needs a same-origin request. */
export async function authorizeAgentAdmin(request: Request, write = false) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return { env, user: null, error: session.error };
	if (!isPrimaryAdmin(session.user))
		return { env, user: null, error: Response.json({ error: "Forbidden" }, { status: 403 }) };
	if (write && !hasValidSessionMutationOrigin(request))
		return { env, user: null, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, user: session.user, error: null };
}

export async function adminAgentResponse(env: CloudflareEnv, init: { status?: number } = {}) {
	const saved = await listAgentProviders(env);
	return Response.json(
		{
			config: await getAgentProviderPublicConfig(env),
			providers: saved.providers,
			providersReady: saved.ready,
			assistantEnabled: await getAgentEnabled(env),
			cloudflareAvailable: !!env.AI,
			...(await getAutoReadAdminSettings(env)),
		},
		{ status: init.status, headers: { "Cache-Control": "no-store" } },
	);
}

export async function GET(request: Request) {
	const access = await authorizeAgentAdmin(request);
	if (access.error) return access.error;
	return adminAgentResponse(access.env);
}

async function saveAssistantEnabled(env: CloudflareEnv, enabled: boolean) {
	const db = getDb(env);
	await db
		.insert(appSettings)
		.values({ id: AGENT_SETTINGS_ID, agentEnabled: enabled })
		.onConflictDoUpdate({
			target: appSettings.id,
			set: { agentEnabled: enabled, updatedAt: new Date() },
		});
	if (!enabled) {
		const pending = eq(agentJobs.status, "pending");
		await db
			.update(agentJobs)
			.set({ status: "skipped", reason: "assistant_disabled" })
			.where(and(pending, eq(agentJobs.kind, "triage")));
		await db
			.update(agentJobs)
			.set({ status: "skipped", reason: "Assistant disabled" })
			.where(and(pending, ne(agentJobs.kind, "triage")));
		await db.update(agentSendApprovals).set({ status: "cancelled" }).where(eq(agentSendApprovals.status, "pending"));
	}
	return Response.json({ assistantEnabled: enabled }, { headers: { "Cache-Control": "no-store" } });
}

async function saveAutoRead(env: CloudflareEnv, body: unknown) {
	const parsed = autoReadAdminSchema.safeParse(body);
	if (!parsed.success) return Response.json({ error: "Invalid automatic reading settings" }, { status: 400 });
	try {
		await saveAutoReadAdminSettings(env, parsed.data);
	} catch (error) {
		if (!(error instanceof TokenCapsPendingError)) throw error;
		return Response.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
	return adminAgentResponse(env);
}

/**
 * The provider form without an id saves the provider in use: the active saved provider (created when none is saved
 * yet), or before migration 0077 the legacy `app_settings` columns, as it always did.
 */
async function saveActiveProvider(env: CloudflareEnv, body: unknown) {
	const parsed = providerSchema.safeParse(body);
	if (!parsed.success) return Response.json({ error: "Invalid provider settings" }, { status: 400 });
	const prepared = await prepareAgentProviderValues(env, parsed.data, "active");
	if (prepared.error !== undefined) return Response.json({ error: prepared.error }, { status: 400 });
	const { ready } = await listAgentProviders(env);
	const activeId = ready ? await activeAgentProviderId(env) : null;
	if (!ready) await saveLegacyAgentProvider(env, prepared.values);
	else if (activeId) await updateAgentProvider(env, activeId, prepared.values);
	else await createAgentProvider(env, prepared.values, { activate: true });
	return adminAgentResponse(env);
}

export async function PUT(request: Request) {
	const access = await authorizeAgentAdmin(request, true);
	if (access.error) return access.error;
	const body = await request.json().catch(() => null);
	const enabled = enabledSchema.strict().safeParse(body);
	if (enabled.success) return saveAssistantEnabled(access.env, enabled.data.enabled);
	if (isAutoReadAdminBody(body)) return saveAutoRead(access.env, body);
	return saveActiveProvider(access.env, body);
}
