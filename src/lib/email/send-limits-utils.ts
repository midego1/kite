import type { SendLimits, SendUsage } from "./send-limits-types";

const DEFAULT_SEND_LIMITS: SendLimits = { perHour: 100, perDay: 500 };

/** Prefix of the error message; the send routes map it to HTTP 429. */
export const SEND_LIMIT_ERROR_PREFIX = "Sending limit reached";

/**
 * Reads a limit from an environment value. Unset or unreadable values fall back to the default,
 * and `0` turns that window's limit off.
 */
function parseSendLimit(value: string | undefined, fallback: number): number {
	const trimmed = value?.trim();
	if (!trimmed) return fallback;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

export function resolveSendLimits(env: { SEND_LIMIT_PER_HOUR?: string; SEND_LIMIT_PER_DAY?: string }): SendLimits {
	return {
		perHour: parseSendLimit(env.SEND_LIMIT_PER_HOUR, DEFAULT_SEND_LIMITS.perHour),
		perDay: parseSendLimit(env.SEND_LIMIT_PER_DAY, DEFAULT_SEND_LIMITS.perDay),
	};
}

/** The message to refuse a send with, or null while the user is under both limits. */
export function describeSendLimitBreach(usage: SendUsage, limits: SendLimits): string | null {
	if (limits.perHour > 0 && usage.lastHour >= limits.perHour) {
		return `${SEND_LIMIT_ERROR_PREFIX}: at most ${limits.perHour} messages an hour. Try again later, or ask an administrator to raise SEND_LIMIT_PER_HOUR.`;
	}
	if (limits.perDay > 0 && usage.lastDay >= limits.perDay) {
		return `${SEND_LIMIT_ERROR_PREFIX}: at most ${limits.perDay} messages a day. Try again later, or ask an administrator to raise SEND_LIMIT_PER_DAY.`;
	}
	return null;
}
