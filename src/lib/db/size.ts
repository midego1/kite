import { isNodeRuntime } from "@/lib/runtime";
import { createLogger } from "@/lib/logger.mjs";
import { type DatabaseSize, TEST_DATABASE_SIZE_HEADER, d1MaxBytes, parseTestDatabaseSize } from "./size-utils";

const logger = createLogger("db-size");

/**
 * How big the database is now. Every D1 result carries `meta.size_after`, so a trivial statement on the raw
 * binding answers it; on Node the SQLite wrapper fills the same field from `page_count * page_size`
 * (`server/runtime/sqlite-database.ts`). There is no limit on Node. Returns null when the binding reports
 * no size, so callers treat an unknown size as "no warning", never as full.
 */
export async function getDatabaseSize(
	env: CloudflareEnv,
	override?: DatabaseSize | null,
): Promise<DatabaseSize | null> {
	if (override) return override;
	try {
		const result = await env.DB.prepare("SELECT 1").run();
		const usedBytes = Number((result.meta as { size_after?: number } | undefined)?.size_after);
		if (!Number.isFinite(usedBytes) || usedBytes <= 0) return null;
		return { usedBytes, limitBytes: isNodeRuntime(env) ? null : d1MaxBytes(env.D1_MAX_BYTES) };
	} catch (error) {
		logger.warn("db_size.unavailable", { error });
		return null;
	}
}

/** The size a test injected with a request header; null unless `DATABASE_SIZE_TEST_HEADER` opts in, and always in production. */
export function testDatabaseSize(
	env: Pick<CloudflareEnv, "DATABASE_SIZE_TEST_HEADER">,
	request: Request,
): DatabaseSize | null {
	return parseTestDatabaseSize(
		request.headers.get(TEST_DATABASE_SIZE_HEADER),
		env.DATABASE_SIZE_TEST_HEADER,
		process.env.NODE_ENV,
	);
}
