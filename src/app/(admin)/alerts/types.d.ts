import type { AlertWebhookKind, AlertWebhookKindSetting } from "@/lib/alerts/alerts-types";

export interface AlertWebhookStatus {
	configured: boolean;
	maskedUrl: string | null;
	kind: AlertWebhookKindSetting;
	effectiveKind: AlertWebhookKind | null;
}

export type AlertWebhookTestResult =
	{ ok: true; status?: number } | { ok: false; reason?: string; status?: number; error?: string };
