import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { createMount, listMounts } from "@/lib/drive/mounts";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	return driveJson(env, () => listMounts(env, user), { mounts: [], encryptionReady: !!env.APP_ENCRYPTION_KEY?.trim() });
});

export const POST = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const body = await readJson(request);
	return driveJson(env, () => createMount(env, user, body));
});
