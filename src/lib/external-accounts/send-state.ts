import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountSendStates } from "@/db/schema/external-accounts";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";

type StateEnv = Pick<CloudflareEnv, "DB">;

/**
 * When each account's SMTP sign-in last succeeded (spec §7.2), by id. Before migration 0083 the column is missing and
 * every account reads as not verified, so nothing is offered as a sender until the database is updated.
 */
export async function readSmtpVerified(env: StateEnv, ids: readonly string[]): Promise<Map<string, Date | null>> {
	const result = new Map<string, Date | null>();
	if (!ids.length) return result;
	try {
		const rows = await getDb(env)
			.select({ id: externalAccountSendStates.id, smtpVerifiedAt: externalAccountSendStates.smtpVerifiedAt })
			.from(externalAccountSendStates)
			.where(inArray(externalAccountSendStates.id, [...ids]));
		for (const row of rows) result.set(row.id, row.smtpVerifiedAt);
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
	}
	return result;
}

/** Records the outcome of an SMTP sign-in: the time it worked, or null when it no longer does. No-op before 0083. */
export async function writeSmtpVerified(env: StateEnv, id: string, at: Date | null): Promise<void> {
	try {
		await getDb(env)
			.update(externalAccountSendStates)
			.set({ smtpVerifiedAt: at })
			.where(eq(externalAccountSendStates.id, id));
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
	}
}
