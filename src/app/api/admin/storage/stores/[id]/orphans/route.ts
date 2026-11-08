import { authorizeStorage, storageResult } from "@/lib/storage/admin-api";
import { purgeStoreOrphans } from "@/lib/storage/store-orphans";

type Params = { params: Promise<{ id: string }> };

/** The "Delete leftovers" admin action: deletes this store's orphan candidates past their grace period. */
export async function DELETE(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await purgeStoreOrphans(access.env, access.actor, id));
}
