export type AlertRuleId = "backup_failed" | "outbound_failed" | "outbound_stuck" | "webhook_exhausted";

/** Timestamps are milliseconds. Only ids, counts and times are collected, never payloads or error text. */
export type AlertSnapshot = {
	failedBackups: { id: string; completedAt: number }[];
	outboundFailed: number;
	outboundStuck: number;
	webhookExhausted: number;
	webhookLastAttemptAt: number | null;
};

export type ActiveAlert = { rule: AlertRuleId; fingerprint: string; count: number };

export type AlertState = {
	version: 1;
	initializedAt: number;
	lastEmailAt?: number;
	lastAttemptAt?: number;
	rules: Partial<Record<AlertRuleId, { fingerprint: string; notifiedAt: number }>>;
};

export type AlertWebhookKind = "slack" | "discord" | "ntfy" | "json";

export type AlertWebhookKindSetting = "auto" | AlertWebhookKind;

export type AlertWebhookUrlErrorCode = "invalid_url" | "credentials_not_allowed" | "https_required" | "blocked_host";

export type AlertWebhookUrlValidation =
	{ ok: true; url: URL; loopback: boolean } | { ok: false; code: AlertWebhookUrlErrorCode };

/** Everything a channel may send: rule ids, names, counts, links and a timestamp. */
export type AlertMessage = {
	appName: string;
	appUrl: string | null;
	alerts: { rule: AlertRuleId | "test"; name: string; count: number; path: string }[];
	sentAt: Date;
	test: boolean;
};

export type ChannelResult = {
	channel: "email" | "webhook";
	outcome: "sent" | "failed" | "skipped";
	reason?: string;
};

export type AlertPolicy = {
	outboundFailedThreshold: number;
	windowMinutes: number;
	stuckQueuedMinutes: number;
	stuckSendingMinutes: number;
	webhookExhaustedThreshold: number;
	remindAfterHours: number;
	minEmailIntervalMinutes: number;
	sendBackoffMinutes: number;
};
