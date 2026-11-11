import type { PasskeySummary } from "@/lib/auth/passkeys-types";

export type PasskeyList = {
	/** False until migration 0112 is applied. */
	available: boolean;
	passkeys: PasskeySummary[];
};

/** How the dialog re-checks it is the account holder: the password, or a code from the authenticator app. */
export type PasskeyReauth = { password: string } | { code: string };
