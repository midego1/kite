import { z } from "zod";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { clearStaleVectors, disableSemanticSearch, rebuildSemanticIndex } from "@/lib/semantic/admin-actions";
import { parseCompatibleEmbeddingBaseUrl } from "@/lib/semantic/embedding";
import { saveSemanticAdminSettings } from "@/lib/semantic/install-settings";
import { getSemanticStatus } from "@/lib/semantic/status";

const noStore = { "Cache-Control": "no-store" };

/** Admin -> Agent -> Search by meaning: settings, progress and the estimated cost to finish the backfill. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return Response.json(await getSemanticStatus(env), { headers: noStore });
}

const settingsSchema = z
	.object({
		enabled: z.boolean().optional(),
		embeddingProvider: z.enum(["workers_ai", "compatible"]).nullable().optional(),
		compatibleBaseUrl: z.string().trim().max(2000).nullable().optional(),
		compatibleApiKey: z.string().trim().max(2000).optional(),
		backfillPaused: z.boolean().optional(),
		backfillCapShare: z.number().int().min(0).max(100).optional(),
	})
	.strict();

/**
 * The primary admin changes the settings; turning the feature off goes through `disableSemanticSearch` instead.
 * Before migration 0099 the answer is 409 `MIGRATION_PENDING` (the UI already disables itself then; this only
 * covers a direct API call).
 */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return Response.json({ error: "Invalid origin" }, { status: 403, headers: noStore });
	const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid settings" }, { status: 400, headers: noStore });
	if (parsed.data.compatibleBaseUrl) {
		try {
			parsed.data.compatibleBaseUrl = parseCompatibleEmbeddingBaseUrl(parsed.data.compatibleBaseUrl, env);
		} catch {
			return Response.json({ error: "Enter a valid HTTPS provider base URL" }, { status: 400, headers: noStore });
		}
	}
	const before = await getSemanticStatus(env);
	if (!before.ready)
		return Response.json(
			{ error: "Apply the pending database update to change this setting", code: "MIGRATION_PENDING" },
			{ status: 409, headers: noStore },
		);
	if (parsed.data.enabled === false && before.settings.enabled) {
		await disableSemanticSearch(env);
		await createAuditLog(env, { actorUserId: auth.user.id, action: "search.semantic_disabled" });
		const { enabled: _enabled, ...rest } = parsed.data;
		if (Object.keys(rest).length > 0) await saveSemanticAdminSettings(env, rest);
	} else {
		await saveSemanticAdminSettings(env, parsed.data);
		if (parsed.data.enabled === true && !before.settings.enabled)
			await createAuditLog(env, { actorUserId: auth.user.id, action: "search.semantic_enabled" });
	}
	return Response.json(await getSemanticStatus(env), { headers: noStore });
}

const actionSchema = z.object({ action: z.enum(["rebuild", "clear_stale_vectors"]) });

/** `{ action: "rebuild" }` queues every indexable row again; `{ action: "clear_stale_vectors" }` removes orphans. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return Response.json({ error: "Invalid origin" }, { status: 403, headers: noStore });
	const parsed = actionSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return Response.json(
			{ error: 'action must be "rebuild" or "clear_stale_vectors"' },
			{ status: 400, headers: noStore },
		);
	if (parsed.data.action === "rebuild") {
		await rebuildSemanticIndex(env);
		await createAuditLog(env, { actorUserId: auth.user.id, action: "search.semantic_rebuild" });
		return Response.json(await getSemanticStatus(env), { headers: noStore });
	}
	const result = await clearStaleVectors(env);
	if (result.supported)
		await createAuditLog(env, {
			actorUserId: auth.user.id,
			action: "search.semantic_clear_stale",
			metadata: { removed: result.removed },
		});
	return Response.json({ ...result, status: await getSemanticStatus(env) }, { headers: noStore });
}
