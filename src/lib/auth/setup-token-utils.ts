import { timingSafeEqual } from "@/lib/auth/totp";
import type { SetupTokenDecision, SetupTokenInput } from "./setup-token-types";

export const SETUP_TOKEN_HEADER = "X-Setup-Token";

const MIN_SETUP_TOKEN_LENGTH = 16;

/**
 * The Deploy to Cloudflare button offers the value from .dev.vars.example as the
 * default, so a deploy that keeps it would have a setup token anyone can read.
 */
const EXAMPLE_SETUP_TOKENS = new Set(["a-long-random-string"]);

/**
 * Before the first admin exists, whoever reaches /register first would become
 * admin. A configured SETUP_TOKEN closes that window; production refuses to run
 * first-run setup without one (or with the example value or a short one),
 * development stays open unless one is set.
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
	if (production && (EXAMPLE_SETUP_TOKENS.has(expected) || expected.length < MIN_SETUP_TOKEN_LENGTH)) {
		return {
			ok: false,
			status: 503,
			setupTokenRequired: true,
			error: `SETUP_TOKEN is the example value or shorter than ${MIN_SETUP_TOKEN_LENGTH} characters. Replace it with a long random string (for example from \`openssl rand -hex 32\`) under the Worker's Variables and secrets, then reload this page.`,
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
