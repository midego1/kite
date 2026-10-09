import type { getTableColumns, SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import type { messages } from "@/db/schema";
import type { MessageListCursor } from "@/lib/messages/cursor-types";

export type ListMessage = Omit<typeof messages.$inferSelect, "textBody" | "htmlBody">;

export type MessageListColumns = Omit<ReturnType<typeof getTableColumns<typeof messages>>, "textBody" | "htmlBody">;

export type ConversationPageInput = {
	db: AppDatabase;
	where: SQL | undefined;
	offset: number;
	limit: number;
	/** When set, pages by keyset after this row and ignores `offset`. */
	cursor?: MessageListCursor | null;
};

export type ConversationPage = {
	ids: string[];
	total: number;
};
