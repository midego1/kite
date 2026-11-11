import { getBranding } from "@/lib/branding/service";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { signInChangeMail, type SignInChange } from "@/lib/auth/passkey-utils";

/**
 * Mails the account holder that a way to sign in changed: to their recovery address when they set one (out of reach
 * of whoever holds a session), otherwise to the account address. Never fails the request that made the change.
 */
export async function noticeSignInChange(
	env: CloudflareEnv,
	user: { email: string; resetEmail: string | null },
	change: SignInChange,
): Promise<void> {
	try {
		const { appName } = await getBranding(env);
		const { subject, text } = signInChangeMail(change, appName);
		const sent = await sendSystemEmail(env, { to: user.resetEmail?.trim() || user.email, subject, text });
		if (!sent) console.warn("Sign-in change notice not sent: no domain can send mail", { kind: change.kind });
	} catch (error) {
		console.warn("Sign-in change notice failed", {
			kind: change.kind,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}
