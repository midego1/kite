import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentJobs, agentSendApprovals, appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import {
	getAgentEnabled,
	getAgentProviderConfig,
	getAgentProviderPublicConfig,
	resolveAgentBaseUrl,
} from "@/lib/agent/provider";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { parseAgentModelIds } from "@/lib/agent/model-ids";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { sealSetting } from "@/lib/security/secret-box";
import { AGENT_REASONING_EFFORTS } from "@/lib/agent/reasoning-effort-utils";
import { autoReadAdminSchema, isAutoReadAdminBody } from "@/lib/agent/auto-read/settings-utils";
import { getAutoReadAdminSettings, saveAutoReadAdminSettings } from "@/lib/agent/auto-read/install-settings";

const providerSchema = z.object({
	provider: z.enum(["cloudflare", "compatible"]),
	preset: z.enum(["haimaker", "anthropic", "openai", "openrouter", "groq", "custom"]),
	baseUrl: z.string().max(500),
	apiKey: z.string().max(2_000).optional(),
	model: z.string().trim().min(1).max(5_000),
	rates: z
		.record(
			z.string(),
			z.object({
				input: z.number().min(0).max(1_000_000).nullable(),
				output: z.number().min(0).max(1_000_000).nullable(),
				reasoningEffort: z.enum(AGENT_REASONING_EFFORTS).nullable().optional(),
			}),
		)
		.optional(),
});
const enabledSchema = z.object({ enabled: z.boolean() });

async function authorize(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return { env, error: session.error };
	if (!isPrimaryAdmin(session.user)) return { env, error: Response.json({ error: "Forbidden" }, { status: 403 }) };
	return { env, error: null };
}

async function adminAgentResponse(env: CloudflareEnv) {
	return Response.json(
		{
			config: await getAgentProviderPublicConfig(env),
			assistantEnabled: await getAgentEnabled(env),
			cloudflareAvailable: !!env.AI,
			...(await getAutoReadAdminSettings(env)),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export async function GET(request: Request) {
	const access = await authorize(request);
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
	await saveAutoReadAdminSettings(env, parsed.data);
	return adminAgentResponse(env);
}

function savedRates(modelIds: string[], rates: z.infer<typeof providerSchema>["rates"]) {
	return JSON.stringify(
		Object.fromEntries(
			modelIds.map((model) => {
				const { input = null, output = null, reasoningEffort } = rates?.[model] ?? {};
				return [model, reasoningEffort ? { input, output, reasoningEffort } : { input, output }];
			}),
		),
	);
}

export async function PUT(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await request.json().catch(() => null);
	const enabled = enabledSchema.strict().safeParse(body);
	if (enabled.success) return saveAssistantEnabled(access.env, enabled.data.enabled);
	if (isAutoReadAdminBody(body)) return saveAutoRead(access.env, body);
	const parsed = providerSchema.safeParse(body);
	if (!parsed.success) return Response.json({ error: "Invalid provider settings" }, { status: 400 });
	const input = parsed.data;
	const modelIds = parseAgentModelIds(input.model);
	if (modelIds.length === 0 || modelIds.length > 20 || modelIds.some((model) => model.length > 200))
		return Response.json({ error: "Choose 1 to 20 valid model IDs" }, { status: 400 });
	if (input.provider === "cloudflare" && !access.env.AI)
		return Response.json({ error: "Cloudflare Workers AI binding is unavailable" }, { status: 400 });
	let baseUrl: string | null = null;
	let apiKey: string | null = null;
	if (input.provider === "compatible") {
		try {
			baseUrl = resolveAgentBaseUrl(input.preset, input.baseUrl, access.env);
		} catch {
			return Response.json({ error: "Enter a valid HTTPS provider base URL" }, { status: 400 });
		}
		const current = await getAgentProviderConfig(access.env);
		apiKey =
			input.apiKey?.trim() ||
			(current.provider === "compatible" && current.preset === input.preset && current.baseUrl === baseUrl
				? current.apiKey
				: "") ||
			null;
		if (!apiKey) return Response.json({ error: "Enter an API key for this provider" }, { status: 400 });
	}
	const values = {
		agentProvider: input.provider,
		agentPreset: input.provider === "compatible" ? input.preset : null,
		agentBaseUrl: baseUrl,
		agentApiKey: await sealSetting(access.env, apiKey),
		agentModel: modelIds.join(", "),
		agentModelRates: savedRates(modelIds, input.rates),
		updatedAt: new Date(),
	};
	await getDb(access.env)
		.insert(appSettings)
		.values({ id: AGENT_SETTINGS_ID, ...values })
		.onConflictDoUpdate({ target: appSettings.id, set: values });
	return adminAgentResponse(access.env);
}
