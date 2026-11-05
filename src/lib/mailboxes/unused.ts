import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/**
 * Why a mailbox is not empty and unused: it holds a message (mail arrived, or an account delivered into it) or a
 * connected account delivers into it (deleting the mailbox would delete the account). Null when it has neither. A
 * database that has not applied the connected accounts migration has no accounts to find.
 */
export async function mailboxInUse(db: AppDatabase, mailboxId: string): Promise<"messages" | "account" | null> {
	const [message] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.mailboxId, mailboxId))
		.limit(1);
	if (message) return "messages";
	try {
		const [account] = await db
			.select({ id: externalAccounts.id })
			.from(externalAccounts)
			.where(eq(externalAccounts.mailboxId, mailboxId))
			.limit(1);
		return account ? "account" : null;
	} catch (error) {
		// Only a missing table (before the connected accounts migration) means no accounts; anything else must not pass.
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

/** The refusal shown when a delete that must only remove an unused mailbox finds it in use. */
export function mailboxInUseMessage(reason: "messages" | "account"): string {
	return reason === "messages"
		? "Kite did not delete this mailbox: mail has arrived in it."
		: "Kite did not delete this mailbox: a connected account delivers into it.";
}
