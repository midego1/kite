import { readAuthRechecks } from "./auth-recheck";
import { readIdentities } from "./identity-store";
import { serializeExternalAccount, type ExternalAccountRow } from "./serialize-utils";
import { readSmtpVerified } from "./send-state";
import type { ExternalAccountView } from "./types";

/** `serializeExternalAccount` of each row, with the send-as state and recheck row its id has. */
export async function accountViews(env: CloudflareEnv, rows: ExternalAccountRow[]): Promise<ExternalAccountView[]> {
	const ids = rows.map((row) => row.id);
	const [verified, identities, authRechecks] = await Promise.all([
		readSmtpVerified(env, ids),
		readIdentities(env, ids),
		readAuthRechecks(env, ids),
	]);
	const now = new Date();
	return rows.map((row) =>
		serializeExternalAccount(
			row,
			verified.get(row.id) ?? null,
			now,
			identities.get(row.id),
			authRechecks.get(row.id) ?? null,
		),
	);
}
