import { authorizeStorage, storageJson } from "@/lib/storage/admin-api";
import { storageOverview } from "@/lib/storage/stores";

/** Stores (no secrets), routes, migrations and usage per class. */
export async function GET(request: Request) {
	const access = await authorizeStorage(request, false);
	if (access.error) return access.error;
	return storageJson(await storageOverview(access.env));
}
