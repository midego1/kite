import { authorizeStorage, readBody, storageJson, storageResult } from "@/lib/storage/admin-api";
import { isRoutableClass } from "@/lib/storage/config-utils";
import { switchRoute, type RouteSwitchInput } from "@/lib/storage/route-switch";

type Params = { params: Promise<{ class: string }> };

/** `{ storeId, migrate, copyBackups? }`: points the class at the store and optionally copies its objects. */
export async function PUT(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { class: objectClass } = await params;
	if (!isRoutableClass(objectClass)) return storageJson({ error: "Unknown object class" }, 404);
	const body = await readBody(request);
	if (!body || typeof body !== "object") return storageJson({ error: "Choose a store" }, 400);
	return storageResult(
		await switchRoute(access.env, access.actor, objectClass, body as RouteSwitchInput, access.origin),
	);
}
