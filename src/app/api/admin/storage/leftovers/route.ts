import { authorizeStorage, readBody, storageJson } from "@/lib/storage/admin-api";
import { deleteLeftovers } from "@/lib/storage/cold-leftovers";
import { saveLeftoverSettings } from "@/lib/storage/cold-leftovers-state";

/** `{ storeId? }`: deletes leftover copies of cold storage moves past the grace period, on one store or all, under
 * every check the cleanup runs (primary admin only, audited); answers the run's summary and how many remain. */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const result = await deleteLeftovers(access.env, access.actor.id, await readBody(request));
	if (!result.ok) {
		const { ok: _ok, status, ...body } = result;
		return storageJson(body, status);
	}
	return storageJson(result.run);
}

/** `{ automatic, graceDays }`: the automatic cleanup (off by default) and the grace period both cleanups wait. */
export async function PUT(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const result = await saveLeftoverSettings(access.env, access.actor.id, await readBody(request));
	if (!result.ok) {
		const { ok: _ok, status, ...body } = result;
		return storageJson(body, status);
	}
	return storageJson({ settings: result.settings });
}
