import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import {
	forEachIdChunk,
	idsOfKind,
	refKey,
	refsOf,
	refsOutput,
	viewerId,
	type FoundRef,
} from "@/lib/modules/handler-helpers";
import type { CapabilityHandler } from "@/lib/modules/module-types";

/** Templates are the user's own rows with status "template". There is no templates page, so there is no link. */
export const resolveTemplateRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	if (userId) {
		const db = () => getDb(getEnv());
		await forEachIdChunk(idsOfKind(refs, "templates:template"), async (chunk) => {
			const rows = await db()
				.select({ id: messages.id, subject: messages.subject })
				.from(messages)
				.where(and(eq(messages.userId, userId), eq(messages.status, "template"), inArray(messages.id, chunk)));
			for (const row of rows)
				found.set(refKey("templates:template", row.id), {
					href: null,
					label: row.subject?.trim() || "Untitled template",
				});
		});
	}
	return refsOutput(refs, found);
};
