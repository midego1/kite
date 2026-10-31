import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { queryInChunks } from "@/db/chunk-utils";
import { conversationScopes } from "./utils";

/**
 * Widens `messageIds` to every message of their conversations in the folder each one is in (see
 * `conversationScopes`), keeping the given ids first. Access is still checked per message afterwards.
 */
export async function expandToConversations(db: AppDatabase, messageIds: readonly string[]): Promise<string[]> {
	const rows = await queryInChunks(messageIds, (ids) =>
		db
			.select({
				mailboxId: messages.mailboxId,
				threadId: messages.threadId,
				status: messages.status,
				folderId: messages.folderId,
			})
			.from(messages)
			.where(inArray(messages.id, ids)),
	);
	const expanded = new Set(messageIds);
	for (const scope of conversationScopes(rows)) {
		const members = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.mailboxId, scope.mailboxId),
					eq(messages.threadId, scope.threadId),
					eq(messages.status, scope.status),
					scope.folderId ? eq(messages.folderId, scope.folderId) : isNull(messages.folderId),
				),
			);
		for (const member of members) expanded.add(member.id);
	}
	return [...expanded];
}
