import { authorizeStorage, readBody, storageJson, storageResult } from "@/lib/storage/admin-api";
import { allowStorageTest } from "@/lib/storage/rate-limit";
import { testStoreInput } from "@/lib/storage/stores";

/** Test connection: runs the checklist on the form as typed and saves nothing. */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	if (!(await allowStorageTest(access.env, access.actor.id)))
		return storageJson({ error: "Too many connection tests; wait a minute and try again" }, 429);
	return storageResult(await testStoreInput(access.env, access.actor, await readBody(request), access.origin));
}
