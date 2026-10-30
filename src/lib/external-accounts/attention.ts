import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { connectRefusal } from "./access";
import type { ExternalAccountView } from "./types";

/**
 * The user's accounts that need them (spec §6.5): sign-in or certificate failures, and errors that stopped checking or
 * have lasted a day. For the sidebar notice; empty while connected accounts are unavailable to the user.
 */
export async function listAccountsNeedingAttention(
	env: CloudflareEnv,
	userId: string,
): Promise<Pick<ExternalAccountView, "id" | "address" | "status">[]> {
	if (await connectRefusal(env, userId)) return [];
	const rows = await getDb(env)
		.select({ id: externalAccounts.id, address: externalAccounts.address, status: externalAccounts.status })
		.from(externalAccounts)
		.where(
			and(
				eq(externalAccounts.userId, userId),
				inArray(externalAccounts.status, ["auth_failed", "tls_failed", "error"]),
			),
		)
		.orderBy(asc(externalAccounts.createdAt));
	return rows;
}
