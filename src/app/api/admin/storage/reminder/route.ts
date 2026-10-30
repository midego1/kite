import { authorizeStorage, readBody, storageJson } from "@/lib/storage/admin-api";
import { DirectUploadsStatePendingError, dismissDirectUploadsReminder } from "@/lib/storage/direct-uploads-state";

/** Dismisses (or brings back) the "Direct uploads are off" reminder for the install. */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const body = (await readBody(request)) as { dismissed?: unknown } | null;
	if (typeof body?.dismissed !== "boolean") return storageJson({ error: "Send { dismissed: true | false }" }, 400);
	try {
		await dismissDirectUploadsReminder(access.env, body.dismissed);
	} catch (error) {
		if (error instanceof DirectUploadsStatePendingError)
			return storageJson({ error: error.message, code: "MIGRATION_PENDING" }, 409);
		throw error;
	}
	return storageJson({ dismissed: body.dismissed });
}
