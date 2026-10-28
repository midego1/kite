import { count } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getDatabaseSize, testDatabaseSize } from "@/lib/db/size";
import type { DatabaseSize } from "@/lib/db/size-utils";
import { type ImportEstimate, estimateImport } from "./estimate-utils";

/**
 * What an import of `messages` messages (and `rawBytes` of source mail, when known) would do to the database.
 * Null when the size is unknown (the binding reports none): the import is then neither warned about nor held.
 */
export async function estimateImportForInstall(
	env: CloudflareEnv,
	input: { messages: number | null; rawBytes: number | null },
	override?: DatabaseSize | null,
): Promise<ImportEstimate | null> {
	const size = await getDatabaseSize(env, override);
	if (!size) return null;
	const [row] = await getDb(env).select({ total: count() }).from(messages);
	return estimateImport({
		...input,
		usedBytes: size.usedBytes,
		limitBytes: size.limitBytes,
		installMessageCount: row?.total ?? 0,
	});
}

/**
 * The 409 `DATABASE_NEARLY_FULL` answer for an import start that needs "Import anyway" and did not get it, else null.
 * `confirmed` tells the job to keep going above 90%.
 */
export async function checkImportStart(
	env: CloudflareEnv,
	request: Request,
	input: { messages: number | null; confirmed: boolean },
): Promise<{ refusal: Response | null; confirmed: boolean }> {
	const estimate = await estimateImportForInstall(
		env,
		{ messages: input.messages, rawBytes: null },
		testDatabaseSize(request),
	);
	const required = !!estimate?.requiresConfirmation;
	if (required && !input.confirmed) {
		const error = "The database is or would be above 90% of its size limit. Confirm to import anyway.";
		return {
			refusal: Response.json({ error, code: "DATABASE_NEARLY_FULL", estimate }, { status: 409 }),
			confirmed: false,
		};
	}
	return { refusal: null, confirmed: required };
}
