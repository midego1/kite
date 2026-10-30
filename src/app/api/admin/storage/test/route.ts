import { authorizeStorage, readBody, storageResult } from "@/lib/storage/admin-api";
import { testStoreInput } from "@/lib/storage/stores";

/** Test connection: runs the checklist on the form as typed and saves nothing (at most 5 a minute per admin). */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	return storageResult(await testStoreInput(access.env, access.actor, await readBody(request), access.origin));
}
