import { verifyPassword } from "@/lib/auth/password";
import { matchTotpStep } from "@/lib/auth/totp";
import { claimTotpStep } from "@/lib/auth/totp-steps";

/**
 * Proves the person at the keyboard is the account holder before a sign-in method changes: the password, or a
 * current code from the authenticator app when two-factor authentication is on. Recovery codes are not accepted
 * here, so this never uses one up, and a code is accepted once: its time step is recorded and an earlier or equal
 * step is refused (`claimTotpStep`, shared with sign-in), so a code seen over someone's shoulder cannot be replayed within its window.
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
