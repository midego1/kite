import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { assistantEmailRequests } from "@/db/schema/assistant-email";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { requestReasonText } from "./request-reasons-utils";
import { assistantConversationPath } from "./reply-utils";

export type EmailRequestSummary = {
	id: string;
	subject: string | null;
	status: "queued" | "running" | "answered" | "failed" | "refused";
	reason: string | null;
	createdAt: Date;
	conversationPath: string | null;
};

const MAX_LISTED_REQUESTS = 30;

/** The user's own recent assistant-by-email requests (spec §13, §14), most recent first. */
export async function listEmailRequests(db: AppDatabase, userId: string): Promise<EmailRequestSummary[]> {
	let rows: {
		id: string;
		subject: string | null;
		status: EmailRequestSummary["status"];
		reason: string | null;
		createdAt: Date;
		conversationId: string | null;
	}[];
	try {
		rows = await db
			.select({
				id: assistantEmailRequests.id,
				subject: assistantEmailRequests.subject,
				status: assistantEmailRequests.status,
				reason: assistantEmailRequests.reason,
				createdAt: assistantEmailRequests.createdAt,
				conversationId: assistantEmailRequests.conversationId,
			})
			.from(assistantEmailRequests)
			.where(eq(assistantEmailRequests.userId, userId))
			.orderBy(desc(assistantEmailRequests.createdAt))
			.limit(MAX_LISTED_REQUESTS);
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
	return rows.map((row) => ({
		id: row.id,
		subject: row.subject,
		status: row.status,
		reason: requestReasonText(row.reason),
		createdAt: row.createdAt,
		conversationPath: row.conversationId ? assistantConversationPath(row.conversationId) : null,
	}));
}
