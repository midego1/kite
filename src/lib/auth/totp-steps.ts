import { isNoSuchTableError } from "@/lib/modules/state-utils";

/**
 * One code, one use: records `step` as the user's last accepted TOTP time step (sign-in, enrolment, turning MFA off
 * and re-authentication share it) and answers false when that step, or a later one, was used already, so a code
 * cannot be replayed within its window. Atomic per user (a conditional upsert). Before migration 0112 there is
 * nowhere to record it and a right code is accepted, as it always was.
 */
export async function claimTotpStep(env: CloudflareEnv, userId: string, step: number): Promise<boolean> {
	try {
		const result = await env.DB.prepare(
			`INSERT INTO totp_used_steps (user_id, last_step) VALUES (?, ?)
			ON CONFLICT (user_id) DO UPDATE SET last_step = excluded.last_step WHERE totp_used_steps.last_step < excluded.last_step`,
		)
			.bind(userId, step)
			.run();
		return (result.meta.changes ?? 0) > 0;
	} catch (error) {
		if (isNoSuchTableError(error)) return true;
		throw error;
	}
}
