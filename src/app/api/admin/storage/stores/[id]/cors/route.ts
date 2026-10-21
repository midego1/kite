import { authorizeStorage, storageResult } from "@/lib/storage/admin-api";
import { applyStoreCors } from "@/lib/storage/stores";

type Params = { params: Promise<{ id: string }> };

/** Sets the CORS rule direct uploads need, where the provider lets the bucket's own keys do it. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await applyStoreCors(access.env, id, access.origin));
}
