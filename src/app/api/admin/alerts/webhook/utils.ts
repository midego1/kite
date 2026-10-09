import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { AlertWebhookUrlErrorCode } from "@/lib/alerts/alerts-types";
import {
	AlertWebhookTargetError,
	checkAlertWebhookTarget,
	clearAlertWebhook,
	loadAlertWebhook,
	saveAlertWebhook,
} from "@/lib/alerts/webhook-settings";
import { detectWebhookKind, maskWebhookUrl } from "@/lib/alerts/webhook-utils";

const NO_STORE = { "Cache-Control": "no-store" };

export const NOT_CONFIGURED = "No alert webhook configured";

const URL_ERRORS: Record<AlertWebhookUrlErrorCode, string> = {
	invalid_url: "Enter a valid https URL",
	credentials_not_allowed: "Webhook URLs with a user name or password are not allowed",
	https_required: "The webhook URL must use https",
	blocked_host: "Private and local addresses are not allowed",
};

const schema = z
	.object({
		url: z.string().max(8192).optional(),
		kind: z.enum(["auto", "slack", "discord", "ntfy", "json"]).optional(),
	})
	.refine((value) => value.url !== undefined || value.kind !== undefined);

export function noStoreJson(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

/** Primary admin only; mutations also need a same-origin request. */
export async function authorizeAlertWebhook(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) {
		auth.error.headers.set("Cache-Control", "no-store");
		return { env, error: auth.error };
	}
	if (!isPrimaryAdmin(auth.user)) return { env, error: noStoreJson({ error: "Forbidden" }, 403) };
	if (mutation && !hasValidSessionMutationOrigin(request))
		return { env, error: noStoreJson({ error: "Invalid origin" }, 403) };
	return { env, error: null };
}

async function webhookStatus(env: CloudflareEnv) {
	const saved = await loadAlertWebhook(env);
	if (!saved) {
		return { configured: false, maskedUrl: null, kind: "auto", effectiveKind: null };
	}
	const effectiveKind =
		saved.url !== null || saved.kind !== "auto" ? detectWebhookKind(saved.url ?? "", saved.kind) : null;
	return {
		configured: true,
		maskedUrl: saved.url === null ? null : maskWebhookUrl(saved.url),
		kind: saved.kind,
		effectiveKind,
	};
}

export async function GET(request: Request) {
	const access = await authorizeAlertWebhook(request, false);
	if (access.error) return access.error;
	return noStoreJson(await webhookStatus(access.env));
}

export async function PUT(request: Request) {
	const access = await authorizeAlertWebhook(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return noStoreJson({ error: "Send a webhook URL or a format" }, 400);
	const { url, kind } = parsed.data;
	let target: string | undefined;
	if (url === undefined) {
		if (!(await loadAlertWebhook(access.env))) return noStoreJson({ error: NOT_CONFIGURED }, 400);
	} else {
		try {
			target = (await checkAlertWebhookTarget(access.env, url)).href;
		} catch (error) {
			if (!(error instanceof AlertWebhookTargetError)) throw error;
			return noStoreJson({ error: URL_ERRORS[error.code], code: error.code }, 400);
		}
	}
	await saveAlertWebhook(access.env, { url: target, kind });
	return noStoreJson(await webhookStatus(access.env));
}

export async function DELETE(request: Request) {
	const access = await authorizeAlertWebhook(request, true);
	if (access.error) return access.error;
	await clearAlertWebhook(access.env);
	return noStoreJson(await webhookStatus(access.env));
}
