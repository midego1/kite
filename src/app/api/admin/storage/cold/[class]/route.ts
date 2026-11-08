import { authorizeStorage, readBody, storageJson, storageResult } from "@/lib/storage/admin-api";
import { isRoutableClass } from "@/lib/storage/config-utils";
import { runColdStorageSweep, updateColdRule } from "@/lib/storage/cold";

type Params = { params: Promise<{ class: string }> };

/** `{ afterDays, minBytes, target, enabled }`: validates and saves one class's cold storage rule. */
export async function PUT(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { class: objectClass } = await params;
	return storageResult(await updateColdRule(access.env, access.actor.id, objectClass, await readBody(request)));
}

/** Runs the class's sweep now instead of waiting for the 02:00 cron; a no-op without an enabled rule. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { class: objectClass } = await params;
	if (!isRoutableClass(objectClass)) return storageJson({ error: "Unknown object class" }, 404);
	await runColdStorageSweep(access.env, new Date(), { classes: [objectClass] });
	return storageJson({ ok: true });
}
