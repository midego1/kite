import { authorizeStorage, readBody, storageJson, storageResult } from "@/lib/storage/admin-api";
import { migrationStatus, runMigrationAction, type MigrationActionInput } from "@/lib/storage/route-switch";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, false);
	if (access.error) return access.error;
	const { id } = await params;
	const migration = await migrationStatus(access.env, id);
	return migration ? storageJson({ migration }) : storageJson({ error: "Migration not found" }, 404);
}

/** `{ action: "cancel" | "finish" | "retry" | "purge-source", confirm? }`; purge needs the old store's name. */
export async function POST(request: Request, { params }: Params) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const { id } = await params;
	const body = ((await readBody(request)) ?? {}) as MigrationActionInput;
	return storageResult(await runMigrationAction(access.env, access.actor, id, body));
}
