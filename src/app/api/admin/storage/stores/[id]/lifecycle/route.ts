import { authorizeStorage, storageResult } from "@/lib/storage/admin-api";
import { applyStoreLifecycle } from "@/lib/storage/stores";

type Params = { params: Promise<{ id: string }> };

/** Adds the rule that aborts unfinished multipart uploads after 7 days, to a bucket without lifecycle rules. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await applyStoreLifecycle(access.env, id));
}
