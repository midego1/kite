import { normalizeEmailAddress } from "@/lib/email/address";

/** A redelivered queue message only schedules work for mail stored this recently. */
export const RECOVERY_WINDOW_MS = 30 * 60_000;

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/;

export function withinRecoveryWindow(receivedAt: Date | undefined, now = Date.now()): boolean {
	return !receivedAt || now - receivedAt.getTime() < RECOVERY_WINDOW_MS;
}

export function isAutoSubmitted(headers?: Record<string, string>): boolean {
	if (!headers) return false;
	const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "auto-submitted")?.[1];
	return !!value && value.trim().toLowerCase() !== "no";
}

/**
 * Why a delivered message gets no triage job, or null when it is eligible. List, bulk and
 * no-reply mail is eligible on purpose: triage settles it from facts without a model call.
 */
export function triageMessageGate(input: {
	status: string;
	sender: string;
	headers?: Record<string, string>;
	ownAddresses: string[];
}): string | null {
	if (input.status !== "received") return "not_in_inbox";
	const sender = normalizeEmailAddress(input.sender);
	if (!sender) return "no_sender";
	if (input.ownAddresses.includes(sender)) return "own_address";
	if (BOUNCE_SENDER.test(sender)) return "bounce_sender";
	if (isAutoSubmitted(input.headers)) return "auto_submitted";
	return null;
}

export function isPaused(pausedUntil: Date | null | undefined, now = Date.now()): boolean {
	return !!pausedUntil && pausedUntil.getTime() > now;
}
