import { timingSafeEqual } from "@/lib/auth/totp";
import type { SetupTokenDecision, SetupTokenInput } from "./setup-token-types";

export const SETUP_TOKEN_HEADER = "X-Setup-Token";

/**
 * Before the first admin exists, whoever reaches /register first would become
 * admin. A configured SETUP_TOKEN closes that window; production refuses to run
 * first-run setup without one, development stays open unless one is set.
 */
export function evaluateSetupToken({ configured, provided, production }: SetupTokenInput): SetupTokenDecision {
	const expected = configured?.trim();
	if (!expected) {
		if (!production) return { ok: true };
		return {
			ok: false,
			status: 503,
			setupTokenRequired: true,
			error:
				"Set a SETUP_TOKEN secret before running first-time setup (for example `wrangler secret put SETUP_TOKEN`), then reload this page.",
		};
	}
	const candidate = provided?.trim() ?? "";
	if (candidate && timingSafeEqual(candidate, expected)) return { ok: true };
	return {
		ok: false,
		status: 401,
		setupTokenRequired: true,
		error: candidate ? "That setup token is not correct" : "Enter the setup token for this installation",
	};
}
