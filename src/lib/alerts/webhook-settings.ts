import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { assertPublicHttpUrl } from "@/lib/security/outbound-url";
import { openSetting, sealSetting, SecretBoxError } from "@/lib/security/secret-box";
import { createLogger } from "../logger.mjs";
import type { AlertWebhookKind, AlertWebhookKindSetting, AlertWebhookUrlErrorCode } from "./alerts-types";
import { isAlertWebhookInsecureAllowed, validateAlertWebhookUrl } from "./webhook-utils";

const logger = createLogger("alerts");

/** `url` is null when a URL is stored but cannot be decrypted (missing or changed APP_ENCRYPTION_KEY). */
export type LoadedAlertWebhook = { url: string | null; kind: AlertWebhookKindSetting };

export class AlertWebhookTargetError extends Error {
	constructor(readonly code: AlertWebhookUrlErrorCode) {
		super(`Alert webhook target rejected: ${code}`);
		this.name = "AlertWebhookTargetError";
	}
}

/** Returns null when no URL is saved; never throws for an unreadable sealed value. */
export async function loadAlertWebhook(env: CloudflareEnv): Promise<LoadedAlertWebhook | null> {
	const [row] = await getDb(env)
		.select({ url: appSettings.alertWebhookUrl, kind: appSettings.alertWebhookKind })
		.from(appSettings)
		.where(eq(appSettings.id, "default"))
		.limit(1);
	if (!row?.url) return null;
	const kind = row.kind ?? "auto";
	try {
		return { url: await openSetting(env, row.url), kind };
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		logger.warn("alerts.webhook_unreadable", { error });
		return { url: null, kind };
	}
}

export async function saveAlertWebhook(
	env: CloudflareEnv,
	update: { url?: string; kind?: AlertWebhookKindSetting },
): Promise<void> {
	const values: { alertWebhookUrl?: string; alertWebhookKind?: AlertWebhookKind | null; updatedAt: Date } = {
		updatedAt: new Date(),
	};
	if (update.url !== undefined) values.alertWebhookUrl = await sealSetting(env, update.url);
	if (update.kind !== undefined) values.alertWebhookKind = update.kind === "auto" ? null : update.kind;
	await getDb(env)
		.insert(appSettings)
		.values({ id: "default", ...values })
		.onConflictDoUpdate({ target: appSettings.id, set: values });
}

export async function clearAlertWebhook(env: CloudflareEnv): Promise<void> {
	await getDb(env)
		.update(appSettings)
		.set({ alertWebhookUrl: null, alertWebhookKind: null, updatedAt: new Date() })
		.where(eq(appSettings.id, "default"));
}

/**
 * Runs on save and again before every send, so a name that later resolves to a
 * private address (Node runtime, via RESOLVE_HOST) is refused at delivery time.
 */
export async function checkAlertWebhookTarget(env: CloudflareEnv, raw: string): Promise<URL> {
	const allowInsecureLoopback = isAlertWebhookInsecureAllowed(env.ALERT_WEBHOOK_ALLOW_INSECURE, process.env.NODE_ENV);
	const result = validateAlertWebhookUrl(raw, { allowInsecureLoopback });
	if (!result.ok) throw new AlertWebhookTargetError(result.code);
	if (result.loopback) return result.url;
	try {
		return await assertPublicHttpUrl(env, result.url.href);
	} catch {
		throw new AlertWebhookTargetError("blocked_host");
	}
}
