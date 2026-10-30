import type { DatabaseSize, DatabaseUseLevel } from "@/lib/db/size-utils";

export type DatabaseSizeResponse = { size: DatabaseSize | null; level: DatabaseUseLevel };

/** Shared by the database size card and the overview, so the page asks once. */
export const DATABASE_SIZE_QUERY = ["database-size"] as const;

/** Null when the server cannot answer (not the primary admin, or no size on this runtime). */
export async function fetchDatabaseSize(): Promise<DatabaseSizeResponse | null> {
	const response = await fetch("/api/admin/database-size", { cache: "no-store" });
	return response.ok ? ((await response.json()) as DatabaseSizeResponse) : null;
}
