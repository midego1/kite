export const ASSISTANT_EMAIL_DAILY_LIMIT_MIN = 1;
export const ASSISTANT_EMAIL_DAILY_LIMIT_MAX = 100;

/** The daily request limit as a whole number within the server's bounds, or an error message for the user. */
export function parseDailyLimit(text: string): { ok: true; value: number } | { ok: false; error: string } {
	const trimmed = text.trim();
	const value = Number(trimmed);
	if (
		trimmed === "" ||
		!Number.isInteger(value) ||
		value < ASSISTANT_EMAIL_DAILY_LIMIT_MIN ||
		value > ASSISTANT_EMAIL_DAILY_LIMIT_MAX
	)
		return {
			ok: false,
			error: `Enter a whole number from ${ASSISTANT_EMAIL_DAILY_LIMIT_MIN} to ${ASSISTANT_EMAIL_DAILY_LIMIT_MAX}.`,
		};
	return { ok: true, value };
}
