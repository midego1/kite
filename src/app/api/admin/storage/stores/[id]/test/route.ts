import { authorizeStorage, storageResult } from "@/lib/storage/admin-api";
import { testStore } from "@/lib/storage/stores";

type Params = { params: Promise<{ id: string }> };

/** Runs the checklist against the saved store and records the outcome. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await testStore(access.env, id, access.origin));
}
