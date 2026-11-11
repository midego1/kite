import { verifyPassword } from "@/lib/auth/password";
import { matchTotpStep } from "@/lib/auth/totp";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/**
 * Proves the person at the keyboard is the account holder before a sign-in method changes: the password, or a
 * current code from the authenticator app when two-factor authentication is on. Recovery codes are not accepted
 * here, so this never uses one up, and a code is accepted once: its time step is recorded and an earlier or equal
 * step is refused, so a code seen over someone's shoulder cannot be replayed within its window.
 */
export async function verifyReauthentication(
	env: CloudflareEnv,
	user: { id: string; passwordHash: string; totpEnabled: boolean; totpSecret: string | null },
	input: { password?: string; code?: string },
): Promise<boolean> {
	if (input.password !== undefined && verifyPassword(input.password, user.passwordHash)) return true;
	if (input.code === undefined || !user.totpEnabled || !user.totpSecret) return false;
	const step = await matchTotpStep(user.totpSecret, input.code);
	if (step === null) return false;
	return claimTotpStep(env, user.id, step);
}

/** Records `step` as the user's last used re-authentication code; false when it (or a later one) was used already. */
async function claimTotpStep(env: CloudflareEnv, userId: string, step: number): Promise<boolean> {
	try {
		const result = await env.DB.prepare(
			`INSERT INTO totp_used_steps (user_id, last_step) VALUES (?, ?)
			ON CONFLICT (user_id) DO UPDATE SET last_step = excluded.last_step WHERE totp_used_steps.last_step < excluded.last_step`,
		)
			.bind(userId, step)
			.run();
		return (result.meta.changes ?? 0) > 0;
	} catch (error) {
		// Before migration 0112 there is nowhere to record the step; the code was right, as it always was.
		if (isNoSuchTableError(error)) return true;
		throw error;
	}
}
