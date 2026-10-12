import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { importJobs } from "@/db/schema/import-jobs";
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

/** An import job is visible to the user who started it. The label carries the status, never the source credentials. */
export const resolveImportRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	if (userId) {
		const db = () => getDb(getEnv());
		await forEachIdChunk(idsOfKind(refs, "import:job"), async (chunk) => {
			const rows = await db()
				.select({ id: importJobs.id, label: importJobs.label, status: importJobs.status })
				.from(importJobs)
				.where(and(eq(importJobs.userId, userId), inArray(importJobs.id, chunk)));
			for (const row of rows)
				found.set(refKey("import:job", row.id), { href: "/settings/import", label: `${row.label} (${row.status})` });
		});
	}
	return refsOutput(refs, found);
};
