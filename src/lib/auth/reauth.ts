import { verifyPassword } from "@/lib/auth/password";
import { verifyTotp } from "@/lib/auth/totp";

/**
 * Proves the person at the keyboard is the account holder before a sign-in method changes: the password, or a
 * current code from the authenticator app when two-factor authentication is on. Recovery codes are not accepted
 * here, so this never uses one up.
 */
export async function verifyReauthentication(
	user: { passwordHash: string; totpEnabled: boolean; totpSecret: string | null },
	input: { password?: string; code?: string },
): Promise<boolean> {
	if (input.password !== undefined && verifyPassword(input.password, user.passwordHash)) return true;
	if (input.code !== undefined && user.totpEnabled && user.totpSecret) return verifyTotp(user.totpSecret, input.code);
	return false;
}
