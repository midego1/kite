import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxAgentSettings } from "@/db/schema";
import { applyMutedSenderChange } from "./muted-senders-utils";

const MAX_ATTEMPTS = 3;

async function updateMutedSenders(
	env: CloudflareEnv,
	mailboxId: string,
	sender: string,
	change: "add" | "remove",
): Promise<boolean> {
	const db = getDb(env);
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const [row] = await db
			.select({ capabilities: mailboxAgentSettings.capabilities })
			.from(mailboxAgentSettings)
			.where(eq(mailboxAgentSettings.mailboxId, mailboxId))
			.limit(1);
		if (!row) return false;
		const next = applyMutedSenderChange(row.capabilities, sender, change);
		if (!next) return false;
		// Compare-and-set on the JSON text, so a settings save that lands in between is never overwritten.
		const updated = await db
			.update(mailboxAgentSettings)
			.set({ capabilities: next, updatedAt: new Date() })
			.where(
				and(eq(mailboxAgentSettings.mailboxId, mailboxId), eq(mailboxAgentSettings.capabilities, row.capabilities)),
			)
			.returning({ mailboxId: mailboxAgentSettings.mailboxId });
		if (updated.length > 0) return true;
	}
	return false;
}

/** Adds the sender to `capabilities.mutedSenders`; true only when it was not muted before. */
export function muteSender(env: CloudflareEnv, mailboxId: string, sender: string): Promise<boolean> {
	return updateMutedSenders(env, mailboxId, sender, "add");
}

/** Removes a sender muted by a dismiss that is being undone. */
export async function unmuteSender(env: CloudflareEnv, mailboxId: string, sender: string): Promise<void> {
	await updateMutedSenders(env, mailboxId, sender, "remove");
}
