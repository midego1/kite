import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { bulkItems } from "@/lib/drive/items";
import { withModule } from "@/lib/modules/route-guard";

export const POST = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const body = await readJson(request);
	return driveJson(env, () => bulkItems(env, user, body));
});
