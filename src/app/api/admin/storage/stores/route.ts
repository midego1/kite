import { authorizeStorage, readBody, storageResult } from "@/lib/storage/admin-api";
import { createStore } from "@/lib/storage/stores";

/** Validates the store (spec 4.5) and saves it; 422 with the step report when a required check fails. */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	return storageResult(await createStore(access.env, access.actor, await readBody(request), access.origin));
}
