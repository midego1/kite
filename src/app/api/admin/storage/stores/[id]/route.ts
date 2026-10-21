import { authorizeStorage, readBody, storageResult } from "@/lib/storage/admin-api";
import { deleteStore, updateStore } from "@/lib/storage/stores";

type Params = { params: Promise<{ id: string }> };

/** Re-validates whenever the change touches where or how the store is reached. */
export async function PATCH(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await updateStore(access.env, access.actor, id, await readBody(request), access.origin));
}

/** Refused while a route, a Drive file or a running migration uses the store. */
export async function DELETE(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	return storageResult(await deleteStore(access.env, access.actor, id));
}
