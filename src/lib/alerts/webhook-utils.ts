import { isBlockedHost, isPrivateIpAddress } from "@/lib/security/outbound-url";
import type {
	ActiveAlert,
	AlertMessage,
	AlertWebhookKind,
	AlertWebhookKindSetting,
	AlertWebhookUrlValidation,
} from "./alerts-types";
import { RULE_LABELS, RULE_ORDER } from "./rules-utils";

const MAX_URL_LENGTH = 2048;
const DISCORD_MAX_CONTENT = 2000;
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);

function toUrl(url: URL | string): URL | null {
	if (url instanceof URL) return url;
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function normalizeHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, "");
}

function isDiscordHost(host: string): boolean {
	const bare = host.replace(/^(ptb|canary)\./, "");
	return DISCORD_HOSTS.has(bare);
}

export function detectWebhookKind(url: URL | string, setting: AlertWebhookKindSetting): AlertWebhookKind {
	if (setting !== "auto") return setting;
	const parsed = toUrl(url);
	if (!parsed) return "json";
	const host = normalizeHost(parsed.hostname);
	if (host === "hooks.slack.com") return "slack";
	if (isDiscordHost(host) && parsed.pathname.startsWith("/api/webhooks/")) return "discord";
	if (host === "ntfy.sh") return "ntfy";
	return "json";
}

/** The webhook URL is the credential, so only the host and port are ever shown. */
export function maskWebhookUrl(url: URL | string): string {
	const parsed = toUrl(url);
	return parsed ? `${parsed.host}/…` : "…";
}

export function isAlertWebhookInsecureAllowed(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return (flag === "1" || flag === "true") && nodeEnv !== "production";
}

function isLoopbackHost(hostname: string): boolean {
	const host = normalizeHost(hostname).replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && isPrivateIpAddress(host);
}

export function validateAlertWebhookUrl(
	raw: string,
	opts: { allowInsecureLoopback: boolean },
): AlertWebhookUrlValidation {
	const value = raw.trim();
	if (!value || value.length > MAX_URL_LENGTH) return { ok: false, code: "invalid_url" };
	const url = toUrl(value);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return { ok: false, code: "invalid_url" };
	if (url.username || url.password) return { ok: false, code: "credentials_not_allowed" };
	if (isLoopbackHost(url.hostname)) {
		return opts.allowInsecureLoopback ? { ok: true, url, loopback: true } : { ok: false, code: "blocked_host" };
	}
	if (url.protocol !== "https:") return { ok: false, code: "https_required" };
	if (isBlockedHost(url.hostname)) return { ok: false, code: "blocked_host" };
	return { ok: true, url, loopback: false };
}

function normalizeAppUrl(appUrl: string | null | undefined): string | null {
	return appUrl?.trim() || null;
}

/** Only rule ids, names, counts and paths are copied, so fingerprints never reach a payload. */
export function buildAlertMessage(
	alerts: ActiveAlert[],
	options: { appName: string; appUrl?: string | null; sentAt: Date },
): AlertMessage {
	const sorted = [...alerts].sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
	return {
		appName: options.appName,
		appUrl: normalizeAppUrl(options.appUrl),
		alerts: sorted.map((alert) => ({ rule: alert.rule, count: alert.count, ...RULE_LABELS[alert.rule] })),
		sentAt: options.sentAt,
		test: false,
	};
}

export function buildTestAlertMessage(options: {
	appName: string;
	appUrl?: string | null;
	sentAt: Date;
}): AlertMessage {
	return {
		appName: options.appName,
		appUrl: normalizeAppUrl(options.appUrl),
		alerts: [{ rule: "test", name: "Test alert", count: 1, path: "/alerts" }],
		sentAt: options.sentAt,
		test: true,
	};
}

function subjectOf(message: AlertMessage): string {
	if (message.test) return `${message.appName}: test alert`;
	const count = message.alerts.length;
	return `${message.appName}: ${count} operational alert${count === 1 ? "" : "s"}`;
}

/** Same lines as renderAlertEmail: `- name: count`, then the indented link when the app URL is known. */
function alertLines(message: AlertMessage): string[] {
	const base = message.appUrl?.replace(/\/+$/, "");
	return message.alerts.map((alert) => `- ${alert.name}: ${alert.count}${base ? `\n  ${base}${alert.path}` : ""}`);
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function toAsciiHeader(value: string): string {
	return value.replace(/…/g, "...").replace(/[^\x20-\x7e]/g, "?");
}

export function buildWebhookRequest(
	kind: AlertWebhookKind,
	message: AlertMessage,
): { headers: Record<string, string>; body: string } {
	const subject = subjectOf(message);
	const lines = alertLines(message);
	const text = [subject, "", ...lines].join("\n");
	const json = { "content-type": "application/json" };
	switch (kind) {
		case "slack":
			return { headers: json, body: JSON.stringify({ text }) };
		case "discord":
			return { headers: json, body: JSON.stringify({ content: truncate(text, DISCORD_MAX_CONTENT) }) };
		case "ntfy":
			return {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					Title: toAsciiHeader(subject),
					Priority: message.test ? "default" : "high",
					Tags: message.test ? "white_check_mark" : "warning",
				},
				body: lines.join("\n"),
			};
		default:
			return {
				headers: json,
				body: JSON.stringify({
					app: message.appName,
					alerts: message.alerts.map(({ rule, name, count }) => ({ rule, name, count })),
					url: message.appUrl,
					sentAt: message.sentAt.toISOString(),
					...(message.test ? { test: true } : {}),
				}),
			};
	}
}
