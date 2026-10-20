import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { startUpload } from "@/lib/drive/uploads";
import { withModule } from "@/lib/modules/route-guard";

export const POST = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const body = await readJson(request);
	return driveJson(env, () => startUpload(env, user, body));
});
