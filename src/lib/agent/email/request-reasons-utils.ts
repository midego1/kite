/**
 * Plain words for the reason codes `src/lib/agent/email/intake.ts` and `process.ts` record on an
 * `assistant_email_requests` row, for the Settings → Assistant requests list (spec §13, §14). A code the map does
 * not know (a future reason, or one with a `:send_failed` suffix added when the reply itself could not be sent)
 * still reads as something, never a raw internal string.
 */
const REASON_TEXT: Record<string, string> = {
	user_unavailable: "Your account was not available when this ran.",
	assistant_disabled: "The assistant by email was off when this ran.",
	mailbox_unavailable: "The mailbox for this request was no longer available to you.",
	raw_missing: "The original message could no longer be read.",
	mime_limit: "The original message was too large or complex to read.",
	mailbox_ai_off: "AI is off for this mailbox.",
	external_provider_not_allowed: "The external AI provider is not allowed for automatic requests.",
	not_configured: "No AI provider is configured.",
	spend_cap: "The spending limit for AI requests was reached.",
	model_error: "The AI provider could not answer.",
	no_sending_provider: "The assistant address's domain cannot send mail, so no reply could be sent.",
};

/** The reason in plain words, or a generic fallback for a code the map does not list. */
export function requestReasonText(reason: string | null): string | null {
	if (!reason) return null;
	const [base] = reason.split(":");
	const text = REASON_TEXT[base] ?? REASON_TEXT[reason];
	if (!text) return "Kite could not finish this request.";
	return reason.endsWith(":send_failed") ? `${text} The reply could not be sent either.` : text;
}
